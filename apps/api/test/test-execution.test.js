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

test("test execution runs, history, details, and authorization work end-to-end", async () => {
  let userId;
  let otherUserId;
  const projectIds = [];

  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2) RETURNING id`,
      [`execution-test-${Date.now()}@example.test`, "Execution Test User"],
    );
    userId = userResult.rows[0].id;

    const otherUserResult = await pool.query(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2) RETURNING id`,
      [`execution-other-${Date.now()}@example.test`, "Other Test User"],
    );
    otherUserId = otherUserResult.rows[0].id;

    const createProject = async (ownerId, name, status = "ACTIVE") => {
      const result = await pool.query(
        `INSERT INTO projects (owner_id, name, status)
         VALUES ($1, $2, $3) RETURNING id`,
        [ownerId, name, status],
      );

      projectIds.push(result.rows[0].id);
      return result.rows[0].id;
    };

    const projectId = await createProject(
      userId,
      "Execution Integration Test",
    );

    const emptyProjectId = await createProject(
      userId,
      "Project Without Eligible Cases",
    );

    const missingScriptProjectId = await createProject(
      userId,
      "Project Missing Approved Script",
    );

    const archivedProjectId = await createProject(
      userId,
      "Archived Execution Project",
      "ARCHIVED",
    );

    const otherProjectId = await createProject(
      otherUserId,
      "Other User Project",
    );

    const createRequirement = async (targetProjectId, title, currentVersion) => {
      const result = await pool.query(
        `INSERT INTO requirements
           (project_id, title, content, current_version)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [targetProjectId, title, `${title} requirement content`, currentVersion],
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
      requirementVersion,
      status = "APPROVED",
    ) => {
      const result = await pool.query(
        `INSERT INTO test_cases
           (requirement_id, title, expected_result, requirement_version, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          requirementId,
          title,
          "Expected result is observed.",
          requirementVersion,
          status,
        ],
      );

      return result.rows[0].id;
    };

    const createAutomationScript = async (
      testCaseId,
      version = 1,
      approvalStatus = "APPROVED",
    ) => {
      const result = await pool.query(
        `INSERT INTO automation_scripts
           (test_case_id, name, framework, language, source_code, version, approval_status)
         VALUES ($1, $2, 'PLAYWRIGHT', 'TYPESCRIPT', $3, $4, $5)
         RETURNING id`,
        [
          testCaseId,
          `Automation Script v${version}`,
          `import { test, expect } from "@playwright/test";

test("generated test", async ({ page }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example Domain/);
});`,
          version,
          approvalStatus,
        ],
      );

      return result.rows[0].id;
    };

    // Current requirement version 2: version 1 test case must be excluded.
    const versionedRequirementId = await createRequirement(
      projectId,
      "Versioned Requirement",
      2,
    );

    await createTestCase(
      versionedRequirementId,
      "Stale approved test case",
      1,
    );

    // Current requirement version 1: this case is eligible for execution.
    const currentRequirementId = await createRequirement(
      projectId,
      "Current Requirement",
      1,
    );

    const eligibleTestCaseId = await createTestCase(
      currentRequirementId,
      "Current approved test case",
      1,
    );

    const eligibleAutomationScriptId = await createAutomationScript(
      eligibleTestCaseId,
    );

    const missingScriptRequirementId = await createRequirement(
      missingScriptProjectId,
      "Requirement Without Script",
      1,
    );

    const missingScriptTestCaseId = await createTestCase(
      missingScriptRequirementId,
      "Approved test case without automation script",
      1,
    );

    // Archived requirements must not be included in coverage.
    const archivedRequirementId = await createRequirement(
      projectId,
      "Archived Requirement",
      1,
    );

    await pool.query(
      `UPDATE requirements
      SET status = 'ARCHIVED'
      WHERE id = $1`,
      [archivedRequirementId],
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

    // 4. Verify another user's project cannot be accessed.
    const unauthorizedCoverage = await request(
      `/api/projects/${otherProjectId}/coverage`,
    );

    assert.equal(unauthorizedCoverage.status, 404);
    assert.equal(
      unauthorizedCoverage.body.error.code,
      "PROJECT_NOT_FOUND",
    );

    const unauthorizedCoverageDetails = await request(
      `/api/projects/${otherProjectId}/coverage/details`,
    );

    assert.equal(unauthorizedCoverageDetails.status, 404);
    assert.equal(
      unauthorizedCoverageDetails.body.error.code,
      "PROJECT_NOT_FOUND",
    );

        // Reject run creation when an eligible test case has no approved script.
    const missingScriptRun = await request(
      `/api/projects/${missingScriptProjectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(missingScriptRun.status, 409);
    assert.equal(
      missingScriptRun.body.error.code,
      "NO_APPROVED_AUTOMATION_SCRIPTS",
    );
    assert.equal(
      missingScriptRun.body.error.details.testCases.length,
      1,
    );
    assert.equal(
      missingScriptRun.body.error.details.testCases[0].testCaseId,
      missingScriptTestCaseId,
    );
    assert.equal(
      missingScriptRun.body.error.details.testCases[0].title,
      "Approved test case without automation script",
    );

    // 1. Create a run using only approved test cases from current versions.
    const created = await request(
      `/api/projects/${projectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(created.status, 201);
    assert.equal(created.body.data.testRun.status, "QUEUED");
    assert.equal(created.body.data.testRun.projectId, projectId);
    assert.deepEqual(created.body.data.testRun.summary, {
      total: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      notRun: 1,
    });

    const testRunId = created.body.data.testRun.id;

    // Create a newer approved version after run creation.
    // The existing run must retain its original script association.
    const newerAutomationScriptId = await createAutomationScript(
      eligibleTestCaseId,
      2,
    );

    // 2. Verify that the run has exactly the eligible test case.
    const storedResults = await pool.query(
      `SELECT test_case_id, automation_script_id, status
       FROM test_results
       WHERE test_run_id = $1`,
      [testRunId],
    );

    assert.equal(
      storedResults.rows[0].automation_script_id,
      eligibleAutomationScriptId,
    );
    assert.notEqual(
      storedResults.rows[0].automation_script_id,
      newerAutomationScriptId,
    );

    assert.equal(storedResults.rows.length, 1);
    assert.equal(storedResults.rows[0].test_case_id, eligibleTestCaseId);
    assert.equal(storedResults.rows[0].status, "NOT_RUN");

    // 3. List execution history and verify aggregate counts.
    const history = await request(
      `/api/projects/${projectId}/test-runs?limit=10&offset=0`,
    );

    assert.equal(history.status, 200);
    assert.equal(history.body.data.pagination.count, 1);
    assert.equal(history.body.data.testRuns.length, 1);
    assert.equal(history.body.data.testRuns[0].id, testRunId);
    assert.deepEqual(history.body.data.testRuns[0].summary, {
      total: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      notRun: 1,
    });

    // 4. Retrieve run details and verify requirement-version traceability.
    const details = await request(`/api/test-runs/${testRunId}`);

    assert.equal(details.status, 200);
    assert.equal(details.body.data.testRun.id, testRunId);
    assert.equal(details.body.data.results.length, 1);
    assert.equal(details.body.data.results[0].testCaseId, eligibleTestCaseId);
    assert.equal(details.body.data.results[0].testCaseTitle, "Current approved test case");
    assert.equal(details.body.data.results[0].requirementVersion, 1);
    assert.equal(details.body.data.results[0].isCurrent, true);
    assert.equal(details.body.data.results[0].status, "NOT_RUN");

    assert.equal(
      details.body.data.results[0].automationScriptId,
      eligibleAutomationScriptId,
    );

    // 9. Start the run and reject invalid lifecycle transitions.
    const started = await request(
      `/api/test-runs/${testRunId}/start`,
      { method: "POST" },
    );

    assert.equal(started.status, 200);
    assert.equal(started.body.data.testRun.status, "RUNNING");
    assert.ok(started.body.data.testRun.startedAt);

    const duplicateStart = await request(
      `/api/test-runs/${testRunId}/start`,
      { method: "POST" },
    );

    assert.equal(duplicateStart.status, 409);
    assert.equal(duplicateStart.body.error.code, "INVALID_RUN_STATE");

    // Another user cannot start or modify this run.
    const foreignStart = await request(
      `/api/test-runs/${testRunId}/start`,
      { method: "POST" },
      otherToken,
    );

    assert.equal(foreignStart.status, 404);
    assert.equal(foreignStart.body.error.code, "TEST_RUN_NOT_FOUND");

    // 10. A run cannot complete while results remain NOT_RUN.
    const incompleteCompletion = await request(
      `/api/test-runs/${testRunId}/complete`,
      { method: "POST" },
    );

    assert.equal(incompleteCompletion.status, 409);
    assert.equal(
      incompleteCompletion.body.error.code,
      "INCOMPLETE_TEST_RESULTS",
    );

    // Retrieve the result ID for the eligible test case.
    const resultLookup = await pool.query(
      `SELECT id
       FROM test_results
       WHERE test_run_id = $1 AND test_case_id = $2`,
      [testRunId, eligibleTestCaseId],
    );

    assert.equal(resultLookup.rows.length, 1);

    const resultId = resultLookup.rows[0].id;

        // A result update must not accept a replacement automation script.
    const attemptedScriptReassignment = await request(
      `/api/test-runs/${testRunId}/results/${resultId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "PASSED",
          automationScriptId: newerAutomationScriptId,
        }),
      },
    );

    assert.equal(attemptedScriptReassignment.status, 400);
    assert.equal(
      attemptedScriptReassignment.body.error.code,
      "VALIDATION_ERROR",
    );

    const unchangedResult = await pool.query(
      `SELECT automation_script_id, status
       FROM test_results
       WHERE id = $1`,
      [resultId],
    );

    assert.equal(
      unchangedResult.rows[0].automation_script_id,
      eligibleAutomationScriptId,
    );
    assert.equal(unchangedResult.rows[0].status, "NOT_RUN");

    // 11. Record a successful test result.
    const recordedResult = await request(
      `/api/test-runs/${testRunId}/results/${resultId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "PASSED",
          durationMs: 1200,
        }),
      },
    );

    assert.equal(
      recordedResult.body.data.result.automationScriptId,
      eligibleAutomationScriptId,
    );

    // console.log("Recorded result response:",JSON.stringify(recordedResult.body, null, 2),);
    assert.equal(recordedResult.status, 200);
    assert.equal(recordedResult.body.data.result.id, resultId);
    assert.equal(recordedResult.body.data.result.status, "PASSED");
    assert.equal(recordedResult.body.data.result.durationMs, 1200);

    // A result cannot be recorded twice.
    const duplicateResult = await request(
      `/api/test-runs/${testRunId}/results/${resultId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "FAILED" }),
      },
    );

    assert.equal(duplicateResult.status, 409);
    assert.equal(
      duplicateResult.body.error.code,
      "RESULT_ALREADY_RECORDED",
    );

    // 12. Complete the run and verify its final status and summary.
    const completed = await request(
      `/api/test-runs/${testRunId}/complete`,
      { method: "POST" },
    );

    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.testRun.status, "PASSED");
    assert.ok(completed.body.data.testRun.completedAt);
    assert.equal(completed.body.data.testRun.summary.passed, 1);
    assert.equal(completed.body.data.testRun.summary.notRun, 0);

    // Results cannot be changed after the run is completed.
    const updateAfterCompletion = await request(
      `/api/test-runs/${testRunId}/results/${resultId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "FAILED" }),
      },
    );

    assert.equal(updateAfterCompletion.status, 409);
    assert.equal(
      updateAfterCompletion.body.error.code,
      "INVALID_RUN_STATE",
    );

    // A completed run cannot be started or completed again.
    const restartCompleted = await request(
      `/api/test-runs/${testRunId}/start`,
      { method: "POST" },
    );

    assert.equal(restartCompleted.status, 409);
    assert.equal(restartCompleted.body.error.code, "INVALID_RUN_STATE");

    const completeAgain = await request(
      `/api/test-runs/${testRunId}/complete`,
      { method: "POST" },
    );

    assert.equal(completeAgain.status, 409);
    assert.equal(completeAgain.body.error.code, "INVALID_RUN_STATE");

    // 13. Cancel a queued run.
    const queuedRunResponse = await request(
      `/api/projects/${projectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(queuedRunResponse.status, 201);

    const queuedRunId = queuedRunResponse.body.data.testRun.id;

    const queuedCancellation = await request(
      `/api/test-runs/${queuedRunId}/cancel`,
      { method: "POST" },
    );

    assert.equal(queuedCancellation.status, 200);
    assert.equal(queuedCancellation.body.data.testRun.status, "CANCELLED");
   // A queued run must remain unstarted after cancellation.
    assert.equal(queuedCancellation.body.data.testRun.startedAt, null);
    assert.ok(queuedCancellation.body.data.testRun.completedAt);

    const startCancelledRun = await request(
      `/api/test-runs/${queuedRunId}/start`,
      { method: "POST" },
    );

    assert.equal(startCancelledRun.status, 409);
    assert.equal(startCancelledRun.body.error.code, "INVALID_RUN_STATE");

    // 14. Cancel a running run.
    const runningRunResponse = await request(
      `/api/projects/${projectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(runningRunResponse.status, 201);

    const runningRunId = runningRunResponse.body.data.testRun.id;

    const runningStart = await request(
      `/api/test-runs/${runningRunId}/start`,
      { method: "POST" },
    );

    assert.equal(runningStart.status, 200);
    assert.equal(runningStart.body.data.testRun.status, "RUNNING");

    const originalStartedAt = runningStart.body.data.testRun.startedAt;
    assert.ok(originalStartedAt);

    const runningCancellation = await request(
      `/api/test-runs/${runningRunId}/cancel`,
      { method: "POST" },
    );

    assert.equal(runningCancellation.status, 200);
    assert.equal(runningCancellation.body.data.testRun.status, "CANCELLED");

    // Cancelling a running run must preserve its original start timestamp.
    assert.equal(
      runningCancellation.body.data.testRun.startedAt,
      originalStartedAt,
    );
    assert.ok(runningCancellation.body.data.testRun.completedAt);

    const completeCancelledRun = await request(
      `/api/test-runs/${runningRunId}/complete`,
      { method: "POST" },
    );

    assert.equal(completeCancelledRun.status, 409);
    assert.equal(
      completeCancelledRun.body.error.code,
      "INVALID_RUN_STATE",
    );

    // 15. A failed test result produces a FAILED execution run.
    const failedRunResponse = await request(
      `/api/projects/${projectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(failedRunResponse.status, 201);

    const failedRunId = failedRunResponse.body.data.testRun.id;

    const failedRunStart = await request(
      `/api/test-runs/${failedRunId}/start`,
      { method: "POST" },
    );

    assert.equal(failedRunStart.status, 200);

    const failedResultLookup = await pool.query(
      `SELECT id
       FROM test_results
       WHERE test_run_id = $1 AND test_case_id = $2`,
      [failedRunId, eligibleTestCaseId],
    );

    const failedResultId = failedResultLookup.rows[0].id;

    const failedResult = await request(
      `/api/test-runs/${failedRunId}/results/${failedResultId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "FAILED",
          durationMs: 800,
          errorMessage: "Expected result did not match actual result.",
        }),
      },
    );

    assert.equal(failedResult.status, 200);
    assert.equal(failedResult.body.data.result.status, "FAILED");

    const failedCompletion = await request(
      `/api/test-runs/${failedRunId}/complete`,
      { method: "POST" },
    );

    assert.equal(failedCompletion.status, 200);
    assert.equal(failedCompletion.body.data.testRun.status, "FAILED");
    assert.equal(failedCompletion.body.data.testRun.summary.failed, 1);

    // 5. A user cannot access another user's project or run.
    const foreignProject = await request(
      `/api/projects/${otherProjectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(foreignProject.status, 404);
    assert.equal(foreignProject.body.error.code, "PROJECT_NOT_FOUND");

    const foreignRun = await request(
      `/api/test-runs/${testRunId}`,
      {},
      otherToken,
    );

    assert.equal(foreignRun.status, 404);
    assert.equal(foreignRun.body.error.code, "TEST_RUN_NOT_FOUND");

    // 6. A project without eligible test cases cannot create a run.
    const noCases = await request(
      `/api/projects/${emptyProjectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(noCases.status, 409);
    assert.equal(noCases.body.error.code, "NO_ELIGIBLE_TEST_CASES");

    // 7. Archived projects cannot create execution runs.
    const archived = await request(
      `/api/projects/${archivedProjectId}/test-runs`,
      { method: "POST" },
    );

    assert.equal(archived.status, 409);
    assert.equal(archived.body.error.code, "PROJECT_ARCHIVED");

    // 8. Invalid IDs and pagination parameters are rejected.
    const invalidProject = await request(
      "/api/projects/not-a-uuid/test-runs",
    );

    assert.equal(invalidProject.status, 400);
    assert.equal(invalidProject.body.error.code, "VALIDATION_ERROR");

    const invalidPagination = await request(
      `/api/projects/${projectId}/test-runs?limit=500`,
    );

    assert.equal(invalidPagination.status, 400);
    assert.equal(invalidPagination.body.error.code, "VALIDATION_ERROR");

  } finally {
    if (projectIds.length > 0) {
      // Remove runs first so their result rows are deleted before test cases.
      await pool.query(
        "DELETE FROM test_runs WHERE project_id = ANY($1::uuid[])",
        [projectIds],
      );

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
