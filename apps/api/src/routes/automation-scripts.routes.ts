
import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { generateAutomationScript } from "../services/automation-script-generator.js";

export const automationScriptsRouter = Router();

const uuidSchema = z.uuid();

const reviewSchema = z.object({
  approvalStatus: z.enum(["APPROVED", "REJECTED"]),
}).strict();

type SourceTestCase = {
  id: string;
  title: string;
  description: string | null;
  preconditions: string | null;
  steps: unknown;
  expected_result: string;
  status: string;
  requirement_version: number;
  current_version: number;
};

automationScriptsRouter.post(
  "/test-cases/:testCaseId/automation-scripts/generate",
  requireAuth,
  async (request, response) => {
    const id = uuidSchema.safeParse(request.params.testCaseId);

    if (!id.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid test case ID" },
      });
    }

    const sourceResult = await pool.query<SourceTestCase>(
      `SELECT tc.id, tc.title, tc.description, tc.preconditions, tc.steps,
              tc.expected_result, tc.status, tc.requirement_version,
              r.current_version
       FROM test_cases tc
       JOIN requirements r ON r.id = tc.requirement_id
       JOIN projects p ON p.id = r.project_id
       WHERE tc.id = $1 AND p.owner_id = $2`,
      [id.data, request.authenticatedUserId],
    );

    const source = sourceResult.rows[0];

    if (!source) {
      return response.status(404).json({
        error: { code: "TEST_CASE_NOT_FOUND", message: "Test case not found" },
      });
    }

    if (
      source.status !== "APPROVED" ||
      source.requirement_version !== source.current_version
    ) {
      return response.status(409).json({
        error: {
          code: "INELIGIBLE_TEST_CASE",
          message: "Only approved test cases from the current requirement version can generate automation scripts",
        },
      });
    }

    let generated: Awaited<ReturnType<typeof generateAutomationScript>>;

    try {
      generated = await generateAutomationScript({
        title: source.title,
        description: source.description,
        preconditions: source.preconditions,
        steps: source.steps,
        expectedResult: source.expected_result,
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The local AI service could not generate an automation script";

      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");

      const isNetworkFailure =
        message.includes("fetch failed") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET") ||
        message.includes("ENOTFOUND");

      const isUpstreamServerError =
        /^Ollama returned HTTP 5\d\d$/.test(message);

      const unavailable =
        isTimeout || isNetworkFailure || isUpstreamServerError;

      return response.status(unavailable ? 503 : 502).json({
        error: {
          code: unavailable
            ? "AI_SERVICE_UNAVAILABLE"
            : "AUTOMATION_SCRIPT_GENERATION_FAILED",
          message: unavailable
            ? "Ollama is unavailable or returned an error. Check that it is running and the configured model is installed."
            : message,
        },
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const unchanged = await client.query(
        `SELECT tc.id
         FROM test_cases tc
         JOIN requirements r ON r.id = tc.requirement_id
         JOIN projects p ON p.id = r.project_id
         WHERE tc.id = $1
           AND p.owner_id = $2
           AND tc.title = $3
           AND tc.description IS NOT DISTINCT FROM $4
           AND tc.preconditions IS NOT DISTINCT FROM $5
           AND tc.steps = $6::jsonb
           AND tc.expected_result = $7
           AND tc.status = 'APPROVED'
           AND tc.requirement_version = r.current_version
         FOR UPDATE OF tc, r`,
        [
          source.id,
          request.authenticatedUserId,
          source.title,
          source.description,
          source.preconditions,
          JSON.stringify(source.steps),
          source.expected_result,
        ],
      );

      if (unchanged.rowCount === 0) {
        await client.query("ROLLBACK");

        return response.status(409).json({
          error: {
            code: "TEST_CASE_CHANGED",
            message: "The test case changed during script generation. Refresh and try again.",
          },
        });
      }

      const versionResult = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM automation_scripts
         WHERE test_case_id = $1`,
        [source.id],
      );

      const version = versionResult.rows[0].next_version;

      const inserted = await client.query(
        `INSERT INTO automation_scripts
           (test_case_id, name, framework, language, source_code, version, approval_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
         RETURNING id, test_case_id, name, framework, language,
                   source_code, version, approval_status, created_at, updated_at`,
        [
          source.id,
          generated.name,
          generated.framework,
          generated.language,
          generated.sourceCode,
          version,
        ],
      );

      await client.query("COMMIT");

      return response.status(201).json({
        data: {
          script: inserted.rows[0],
          model: generated.modelName,
          promptVersion: generated.promptVersion,
          requiresHumanReview: true,
          executionEnabled: false,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

automationScriptsRouter.get(
  "/test-cases/:testCaseId/automation-scripts",
  requireAuth,
  async (request, response) => {
    const id = uuidSchema.safeParse(request.params.testCaseId);

    if (!id.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid test case ID" },
      });
    }

    const ownership = await pool.query(
      `SELECT tc.id
       FROM test_cases tc
       JOIN requirements r ON r.id = tc.requirement_id
       JOIN projects p ON p.id = r.project_id
       WHERE tc.id = $1 AND p.owner_id = $2`,
      [id.data, request.authenticatedUserId],
    );

    if (!ownership.rows[0]) {
      return response.status(404).json({
        error: { code: "TEST_CASE_NOT_FOUND", message: "Test case not found" },
      });
    }

    const result = await pool.query(
      `SELECT id, test_case_id, name, framework, language, source_code,
              version, approval_status, created_at, updated_at
       FROM automation_scripts
       WHERE test_case_id = $1
       ORDER BY version DESC`,
      [id.data],
    );

    return response.status(200).json({
      data: { scripts: result.rows },
    });
  },
);

automationScriptsRouter.get(
  "/automation-scripts/:scriptId",
  requireAuth,
  async (request, response) => {
    const id = uuidSchema.safeParse(request.params.scriptId);

    if (!id.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid script ID" },
      });
    }

    const result = await pool.query(
      `SELECT s.id, s.test_case_id, s.name, s.framework, s.language,
              s.source_code, s.version, s.approval_status,
              s.created_at, s.updated_at
       FROM automation_scripts s
       JOIN test_cases tc ON tc.id = s.test_case_id
       JOIN requirements r ON r.id = tc.requirement_id
       JOIN projects p ON p.id = r.project_id
       WHERE s.id = $1 AND p.owner_id = $2`,
      [id.data, request.authenticatedUserId],
    );

    if (!result.rows[0]) {
      return response.status(404).json({
        error: { code: "AUTOMATION_SCRIPT_NOT_FOUND", message: "Automation script not found" },
      });
    }

    return response.status(200).json({
      data: { script: result.rows[0] },
    });
  },
);

automationScriptsRouter.patch(
  "/automation-scripts/:scriptId/review",
  requireAuth,
  async (request, response) => {
    const id = uuidSchema.safeParse(request.params.scriptId);

    if (!id.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid script ID" },
      });
    }

    const parsed = reviewSchema.safeParse(request.body);

    if (!parsed.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "A valid approval status (APPROVED or REJECTED) is required",
        },
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const current = await client.query(
        `SELECT s.id, s.approval_status, tc.status AS test_case_status,
                tc.requirement_version, r.current_version
         FROM automation_scripts s
         JOIN test_cases tc ON tc.id = s.test_case_id
         JOIN requirements r ON r.id = tc.requirement_id
         JOIN projects p ON p.id = r.project_id
         WHERE s.id = $1 AND p.owner_id = $2
         FOR UPDATE OF s, tc, r`,
        [id.data, request.authenticatedUserId],
      );

      const script = current.rows[0];

      if (!script) {
        await client.query("ROLLBACK");

        return response.status(404).json({
          error: {
            code: "AUTOMATION_SCRIPT_NOT_FOUND",
            message: "Automation script not found",
          },
        });
      }

      if (script.approval_status !== "PENDING") {
        await client.query("ROLLBACK");

        return response.status(409).json({
          error: {
            code: "SCRIPT_ALREADY_REVIEWED",
            message: "Only pending automation scripts can be reviewed",
          },
        });
      }

      if (
        parsed.data.approvalStatus === "APPROVED" &&
        (
          script.test_case_status !== "APPROVED" ||
          script.requirement_version !== script.current_version
        )
      ) {
        await client.query("ROLLBACK");

        return response.status(409).json({
          error: {
            code: "INELIGIBLE_TEST_CASE",
            message: "A script can only be approved when its test case is approved and belongs to the current requirement version",
          },
        });
      }

      const updated = await client.query(
        `UPDATE automation_scripts
         SET approval_status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, test_case_id, name, framework, language,
                   source_code, version, approval_status, created_at, updated_at`,
        [parsed.data.approvalStatus, id.data],
      );

      await client.query("COMMIT");

      return response.status(200).json({
        data: { script: updated.rows[0] },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);
