
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL =
  process.env.DATABASE_URL?.replace("?schema=public", "") ??
  "postgresql://testpilot:testpilot_dev_password@localhost:5432/testpilot";

process.env.JWT_SECRET ??=
  "test-only-secret-that-is-long-enough-for-validation";

process.env.WEB_ORIGIN ??= "http://localhost:5173";

const { app } = await import("../src/app.ts");
const { pool } = await import("../src/config/database.ts");
const { createAccessToken } = await import("../src/auth/auth-token.ts");

let server;
let baseUrl;
let originalFetch;

before(async () => {
  server = app.listen(0);

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
  originalFetch = globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;

  if (server) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  await pool.end();
});

test("automation script generation, versioning, review, and ownership work end-to-end", async () => {
  let userId;
  let otherUserId;
  const projectIds = [];

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2) RETURNING id`,
      [`automation-test-${Date.now()}@example.test`, "Automation Test User"],
    );
    userId = userResult.rows[0].id;

    const otherUserResult = await pool.query(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2) RETURNING id`,
      [`automation-other-${Date.now()}@example.test`, "Other Test User"],
    );
    otherUserId = otherUserResult.rows[0].id;

    const createProject = async (ownerId, name) => {
      const result = await pool.query(
        `INSERT INTO projects (owner_id, name)
         VALUES ($1, $2) RETURNING id`,
        [ownerId, name],
      );

      projectIds.push(result.rows[0].id);
      return result.rows[0].id;
    };

    const projectId = await createProject(
      userId,
      "Automation Script Integration Test",
    );

    const otherProjectId = await createProject(
      otherUserId,
      "Other User Automation Project",
    );

    const createRequirement = async (
      targetProjectId,
      title,
      currentVersion = 1,
    ) => {
      const result = await pool.query(
        `INSERT INTO requirements
           (project_id, title, content, current_version)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          targetProjectId,
          title,
          `${title} requirement content`,
          currentVersion,
        ],
      );

      const requirementId = result.rows[0].id;

      for (let version = 1; version <= currentVersion; version += 1) {
        await pool.query(
          `INSERT INTO requirement_versions
             (requirement_id, version, title, content)
           VALUES ($1, $2, $3, $4)`,
          [
            requirementId,
            version,
            `${title} v${version}`,
            `${title} requirement content v${version}`,
          ],
        );
      }

      return requirementId;
    };

    const createTestCase = async (
      requirementId,
      title,
      requirementVersion = 1,
      status = "APPROVED",
    ) => {
      const result = await pool.query(
        `INSERT INTO test_cases
           (requirement_id, title, description, preconditions, steps,
            expected_result, requirement_version, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING id`,
        [
          requirementId,
          title,
          "Verify the login workflow.",
          "A valid test account is available.",
          JSON.stringify([
            { action: "Open the login page" },
            { action: "Enter valid credentials" },
            { action: "Submit the login form" },
          ]),
          "The user is redirected to the dashboard.",
          requirementVersion,
          status,
        ],
      );

      return result.rows[0].id;
    };

    const currentRequirementId = await createRequirement(
      projectId,
      "Current Login Requirement",
      1,
    );

    const approvedTestCaseId = await createTestCase(
      currentRequirementId,
      "Approved login test case",
    );

    const unapprovedTestCaseId = await createTestCase(
      currentRequirementId,
      "Draft login test case",
      1,
      "DRAFT",
    );

    const staleRequirementId = await createRequirement(
      projectId,
      "Versioned Login Requirement",
      2,
    );

    const staleTestCaseId = await createTestCase(
      staleRequirementId,
      "Stale login test case",
      1,
    );

    const otherRequirementId = await createRequirement(
      otherProjectId,
      "Other User Requirement",
    );

    const otherTestCaseId = await createTestCase(
      otherRequirementId,
      "Other user's approved test case",
    );

    const token = await createAccessToken(userId);
    const otherToken = await createAccessToken(otherUserId);

    const request = async (path, options = {}, accessToken = token) => {
      const response = await originalFetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          ...options.headers,
        },
      });

      return {
        status: response.status,
        body: await response.json(),
      };
    };

    const validSourceCode = `
import { test, expect } from "@playwright/test";

test("user can log in", async ({ page }) => {
  await page.goto("https://example.test/login");
  await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();
});
`;

    let ollamaCalls = 0;

    const mockOllama = (sourceCode = validSourceCode) => {
      globalThis.fetch = async () => {
        ollamaCalls += 1;

        return new Response(
          JSON.stringify({
            response: JSON.stringify({
              name: "Login automation test",
              framework: "PLAYWRIGHT",
              language: "TYPESCRIPT",
              sourceCode,
            }),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };
    };

    // 1. Generate a script from an approved, current test case.
    mockOllama();

    const generated = await request(
      `/api/test-cases/${approvedTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(generated.status, 201);
    assert.equal(generated.body.data.script.approval_status, "PENDING");
    assert.equal(generated.body.data.script.version, 1);
    assert.equal(generated.body.data.script.framework, "PLAYWRIGHT");
    assert.equal(generated.body.data.script.language, "TYPESCRIPT");
    assert.equal(generated.body.data.requiresHumanReview, true);
    assert.equal(generated.body.data.executionEnabled, false);
    assert.equal(generated.body.data.promptVersion, "playwright-script-generation-v1");

    const firstScriptId = generated.body.data.script.id;
    assert.ok(firstScriptId);

    // 2. Approve the first generated version.
    const approved = await request(
      `/api/automation-scripts/${firstScriptId}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus: "APPROVED" }),
      },
    );

    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.script.approval_status, "APPROVED");

    // 3. A reviewed script cannot be reviewed a second time.
    const duplicateReview = await request(
      `/api/automation-scripts/${firstScriptId}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus: "REJECTED" }),
      },
    );

    assert.equal(duplicateReview.status, 409);
    assert.equal(
      duplicateReview.body.error.code,
      "SCRIPT_ALREADY_REVIEWED",
    );

    // 4. Generate another version without overwriting the approved version.
    const regenerated = await request(
      `/api/test-cases/${approvedTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(regenerated.status, 201);
    assert.equal(regenerated.body.data.script.version, 2);
    assert.equal(regenerated.body.data.script.approval_status, "PENDING");

    const secondScriptId = regenerated.body.data.script.id;

    assert.notEqual(secondScriptId, firstScriptId);

    // 5. Reject the second version.
    const rejected = await request(
      `/api/automation-scripts/${secondScriptId}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus: "REJECTED" }),
      },
    );

    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.script.approval_status, "REJECTED");

    // 6. List all script versions.
    const listing = await request(
      `/api/test-cases/${approvedTestCaseId}/automation-scripts`,
    );

    assert.equal(listing.status, 200);
    assert.equal(listing.body.data.scripts.length, 2);
    assert.deepEqual(
      listing.body.data.scripts.map(script => script.version),
      [2, 1],
    );

    // The first approved version remains unchanged.
    assert.equal(
      listing.body.data.scripts[1].approval_status,
      "APPROVED",
    );

    // 7. Retrieve an individual script.
    const detail = await request(
      `/api/automation-scripts/${firstScriptId}`,
    );

    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.script.id, firstScriptId);
    assert.equal(detail.body.data.script.version, 1);

    // 8. Unapproved test cases cannot generate scripts.
    const callsBeforeUnapproved = ollamaCalls;

    const unapprovedGeneration = await request(
      `/api/test-cases/${unapprovedTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(unapprovedGeneration.status, 409);
    assert.equal(
      unapprovedGeneration.body.error.code,
      "INELIGIBLE_TEST_CASE",
    );
    assert.equal(ollamaCalls, callsBeforeUnapproved);

    // 9. Stale test cases cannot generate scripts.
    const staleGeneration = await request(
      `/api/test-cases/${staleTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(staleGeneration.status, 409);
    assert.equal(
      staleGeneration.body.error.code,
      "INELIGIBLE_TEST_CASE",
    );


    // 10. A pending script cannot be approved after its requirement becomes stale.
    const staleReviewRequirementId = await createRequirement(
      projectId,
      "Requirement becoming stale before review",
      1,
    );

    const staleReviewTestCaseId = await createTestCase(
      staleReviewRequirementId,
      "Test case becoming stale before review",
    );

    mockOllama();

    const pendingStaleScript = await request(
      `/api/test-cases/${staleReviewTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(pendingStaleScript.status, 201);
    assert.equal(
      pendingStaleScript.body.data.script.approval_status,
      "PENDING",
    );

    const staleReviewScriptId = pendingStaleScript.body.data.script.id;

    await pool.query(
      `INSERT INTO requirement_versions
         (requirement_id, version, title, content)
       VALUES ($1, 2, $2, $3)`,
      [
        staleReviewRequirementId,
        "Requirement becoming stale before review v2",
        "Updated requirement content v2",
      ],
    );

    await pool.query(
      `UPDATE requirements
       SET current_version = 2, updated_at = NOW()
       WHERE id = $1`,
      [staleReviewRequirementId],
    );

    const staleApproval = await request(
      `/api/automation-scripts/${staleReviewScriptId}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus: "APPROVED" }),
      },
    );

    assert.equal(staleApproval.status, 409);
    assert.equal(
      staleApproval.body.error.code,
      "INELIGIBLE_TEST_CASE",
    );

    const staleScriptStatus = await pool.query(
      `SELECT approval_status
       FROM automation_scripts
       WHERE id = $1`,
      [staleReviewScriptId],
    );

    assert.equal(
      staleScriptStatus.rows[0].approval_status,
      "PENDING",
    );


    // 10. Another user cannot generate, list, or retrieve scripts.
    const foreignGeneration = await request(
      `/api/test-cases/${otherTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(foreignGeneration.status, 404);

    const foreignList = await request(
      `/api/test-cases/${otherTestCaseId}/automation-scripts`,
    );

    assert.equal(foreignList.status, 404);

    const foreignDetail = await request(
      `/api/automation-scripts/${firstScriptId}`,
      {},
      otherToken,
    );

    assert.equal(foreignDetail.status, 404);

    const foreignReview = await request(
      `/api/automation-scripts/${firstScriptId}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus: "REJECTED" }),
      },
      otherToken,
    );

    assert.equal(foreignReview.status, 404);

    // 11. Invalid IDs and invalid review payloads are rejected.
    const invalidId = await request(
      "/api/test-cases/not-a-uuid/automation-scripts",
    );

    assert.equal(invalidId.status, 400);
    assert.equal(invalidId.body.error.code, "VALIDATION_ERROR");

    const invalidReview = await request(
      `/api/automation-scripts/${firstScriptId}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ approvalStatus: "PENDING" }),
      },
    );

    assert.equal(invalidReview.status, 400);
    assert.equal(invalidReview.body.error.code, "VALIDATION_ERROR");

    // 12. Invalid generated source must not be persisted.
    const unsafeRequirementId = await createRequirement(
      projectId,
      "Unsafe Script Requirement",
    );

    const unsafeTestCaseId = await createTestCase(
      unsafeRequirementId,
      "Unsafe source test case",
    );

    mockOllama(`
import { test, expect } from "@playwright/test";
import fs from "node:fs";

test("unsafe test", async ({ page }) => {
  expect(true).toBe(true);
});
`);

    const unsafeGeneration = await request(
      `/api/test-cases/${unsafeTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(unsafeGeneration.status, 502);
    assert.equal(
      unsafeGeneration.body.error.code,
      "AUTOMATION_SCRIPT_GENERATION_FAILED",
    );

    const unsafeStored = await pool.query(
      `SELECT id FROM automation_scripts WHERE test_case_id = $1`,
      [unsafeTestCaseId],
    );

    assert.equal(unsafeStored.rows.length, 0);

    // 13. Ollama unavailable returns a service-unavailable response.
    const unavailableRequirementId = await createRequirement(
      projectId,
      "Unavailable AI Requirement",
    );

    const unavailableTestCaseId = await createTestCase(
      unavailableRequirementId,
      "Unavailable AI test case",
    );

    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const unavailable = await request(
      `/api/test-cases/${unavailableTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(unavailable.status, 503);
    assert.equal(
      unavailable.body.error.code,
      "AI_SERVICE_UNAVAILABLE",
    );

        // 14. Ollama client errors are treated as generation failures.
    globalThis.fetch = async () =>
      new Response("Bad request", { status: 400 });

    const clientError = await request(
      `/api/test-cases/${unavailableTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(clientError.status, 502);
    assert.equal(
      clientError.body.error.code,
      "AUTOMATION_SCRIPT_GENERATION_FAILED",
    );

    // 15. Ollama server errors are treated as service unavailable.
    globalThis.fetch = async () =>
      new Response("Internal server error", { status: 500 });

    const serverError = await request(
      `/api/test-cases/${unavailableTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(serverError.status, 503);
    assert.equal(
      serverError.body.error.code,
      "AI_SERVICE_UNAVAILABLE",
    );

    // 16. Ollama request timeouts are treated as service unavailable.
    globalThis.fetch = async () => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      throw error;
    };

    const timeoutError = await request(
      `/api/test-cases/${unavailableTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(timeoutError.status, 503);
    assert.equal(
      timeoutError.body.error.code,
      "AI_SERVICE_UNAVAILABLE",
    );

    // 14. Malformed Ollama JSON is rejected.
    const malformedRequirementId = await createRequirement(
      projectId,
      "Malformed AI Requirement",
    );

    const malformedTestCaseId = await createTestCase(
      malformedRequirementId,
      "Malformed AI test case",
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ response: "not valid JSON" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    const malformed = await request(
      `/api/test-cases/${malformedTestCaseId}/automation-scripts/generate`,
      { method: "POST" },
    );

    assert.equal(malformed.status, 502);
    assert.equal(
      malformed.body.error.code,
      "AUTOMATION_SCRIPT_GENERATION_FAILED",
    );

  } finally {
    globalThis.fetch = originalFetch;

    if (projectIds.length > 0) {
      await pool.query(
        "DELETE FROM projects WHERE id = ANY($1::uuid[])",
        [projectIds],
      );
    }

    if (userId) {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }

    if (otherUserId) {
      await pool.query("DELETE FROM users WHERE id = $1", [otherUserId]);
    }
  }
});
