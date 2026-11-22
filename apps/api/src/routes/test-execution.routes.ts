
import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../config/database.js";
import { requireAuth } from "../middleware/require-auth.js";

export const testExecutionRouter = Router();

const uuidSchema = z.uuid();

const listRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const resultUpdateSchema = z
  .object({
    status: z.enum(["PASSED", "FAILED", "SKIPPED", "ERROR"]),
    durationMs: z.number().int().min(0).optional(),
    errorMessage: z.string().max(10000).nullable().optional(),
    artifactPath: z.string().max(2000).nullable().optional()
  })
  .strict();

type TestRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "PASSED"
  | "FAILED"
  | "CANCELLED";

type TestRunRow = {
  id: string;
  project_id: string;
  triggered_by: string | null;
  status: TestRunStatus;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  total_count?: number;
  passed_count?: number;
  failed_count?: number;
  skipped_count?: number;
  error_count?: number;
  not_run_count?: number;
};

type TestRunSummary = {
  total_count: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  error_count: number;
  not_run_count: number;
};

type TestResultRow = {
  id: string;
  test_case_id: string;
  test_case_title: string;
  requirement_id: string;
  requirement_version: number;
  is_current: boolean;
  automation_script_id: string | null;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
  artifact_path: string | null;
  executed_at: Date | null;
};

function toTestRun(row: TestRunRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    triggeredBy: row.triggered_by,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    ...(row.total_count !== undefined
      ? {
          summary: {
            total: Number(row.total_count),
            passed: Number(row.passed_count ?? 0),
            failed: Number(row.failed_count ?? 0),
            skipped: Number(row.skipped_count ?? 0),
            errors: Number(row.error_count ?? 0),
            notRun: Number(row.not_run_count ?? 0),
          },
        }
      : {}),
  };
}

function toSummary(summary: TestRunSummary) {
  return {
    total: Number(summary.total_count),
    passed: Number(summary.passed_count),
    failed: Number(summary.failed_count),
    skipped: Number(summary.skipped_count),
    errors: Number(summary.error_count),
    notRun: Number(summary.not_run_count),
  };
}

function getAuthenticatedUserId(
  userId: string | undefined,
): string | null {
  return userId ?? null;
}

async function rollbackSafely(
  client: PoolClient,
  transactionOpen: boolean,
): Promise<void> {
  if (transactionOpen) {
    await client.query("ROLLBACK");
  }
}

async function getOwnedRun(
  client: PoolClient,
  testRunId: string,
  userId: string,
  lock = false,
): Promise<TestRunRow | null> {
  const result = await client.query<TestRunRow>(
    `SELECT tr.id, tr.project_id, tr.triggered_by, tr.status,
            tr.started_at, tr.completed_at, tr.created_at
     FROM test_runs tr
     INNER JOIN projects p ON p.id = tr.project_id
     WHERE tr.id = $1 AND p.owner_id = $2
     ${lock ? "FOR UPDATE OF tr" : ""}`,
    [testRunId, userId],
  );

  return result.rows[0] ?? null;
}

async function getRunSummary(
  client: PoolClient,
  testRunId: string,
): Promise<TestRunSummary> {
  const result = await client.query<TestRunSummary>(
    `SELECT
       COUNT(*)::integer AS total_count,
       COUNT(*) FILTER (WHERE status = 'PASSED')::integer AS passed_count,
       COUNT(*) FILTER (WHERE status = 'FAILED')::integer AS failed_count,
       COUNT(*) FILTER (WHERE status = 'SKIPPED')::integer AS skipped_count,
       COUNT(*) FILTER (WHERE status = 'ERROR')::integer AS error_count,
       COUNT(*) FILTER (WHERE status = 'NOT_RUN')::integer AS not_run_count
     FROM test_results
     WHERE test_run_id = $1`,
    [testRunId],
  );

  return result.rows[0];
}


// Return version-aware requirement coverage for an owned project.
testExecutionRouter.get(
  "/projects/:projectId/coverage",


  requireAuth,
  async (request, response) => {
    const parsedProjectId = uuidSchema.safeParse(request.params.projectId);

    if (!parsedProjectId.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid project ID",
        },
      });
    }

    const projectAccess = await pool.query(
      `SELECT 1
      FROM projects
      WHERE id = $1
        AND owner_id = $2`,
      [parsedProjectId.data, request.authenticatedUserId],
    );

    if (projectAccess.rowCount === 0) {
      return response.status(404).json({
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "Project not found",
        },
      });
    }


    const result = await pool.query(
      `SELECT
         COUNT(*)::integer AS total_requirements,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1
             FROM test_cases tc
             WHERE tc.requirement_id = r.id
               AND tc.requirement_version = r.current_version
               AND tc.status = 'APPROVED'
           )
         )::integer AS covered_requirements,
         COUNT(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1
             FROM test_cases tc
             WHERE tc.requirement_id = r.id
               AND tc.requirement_version = r.current_version
               AND tc.status = 'APPROVED'
           )
         )::integer AS uncovered_requirements,
         COALESCE(SUM((
           SELECT COUNT(*)::integer
           FROM test_cases tc
           WHERE tc.requirement_id = r.id
             AND tc.requirement_version = r.current_version
             AND tc.status = 'APPROVED'
         )), 0)::integer AS current_approved_test_cases,
         COALESCE(SUM((
           SELECT COUNT(*)::integer
           FROM test_cases tc
           WHERE tc.requirement_id = r.id
             AND tc.requirement_version < r.current_version
             AND tc.status = 'APPROVED'
         )), 0)::integer AS outdated_approved_test_cases
       FROM requirements r
       INNER JOIN projects p ON p.id = r.project_id
       WHERE p.id = $1
         AND p.owner_id = $2
         AND r.status <> 'ARCHIVED'`,
      [parsedProjectId.data, request.authenticatedUserId],
    );

    const row = result.rows[0];

    if (!row) {
      return response.status(404).json({
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "Project not found",
        },
      });
    }

    const totalRequirements = Number(row.total_requirements);
    const coveredRequirements = Number(row.covered_requirements);

    return response.status(200).json({
      data: {
        coverage: {
          totalRequirements,
          coveredRequirements,
          uncoveredRequirements: Number(row.uncovered_requirements),
          coveragePercentage:
            totalRequirements === 0
              ? 0
              : Number(
                  ((coveredRequirements / totalRequirements) * 100).toFixed(2),
                ),
          currentApprovedTestCases: Number(row.current_approved_test_cases),
          outdatedApprovedTestCases: Number(row.outdated_approved_test_cases),
        },
      },
    });
   },
);


// Return requirement-level coverage details for an owned project.
testExecutionRouter.get(
  "/projects/:projectId/coverage/details",
  requireAuth,
  async (request, response) => {
    const parsedProjectId = uuidSchema.safeParse(request.params.projectId);

    if (!parsedProjectId.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid project ID",
        },
      });
    }

    const projectAccess = await pool.query(
      `SELECT 1
      FROM projects
      WHERE id = $1
        AND owner_id = $2`,
      [parsedProjectId.data, request.authenticatedUserId],
    );

    if (projectAccess.rowCount === 0) {
      return response.status(404).json({
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "Project not found",
        },
      });
    }

    const result = await pool.query(
      `SELECT
         r.id,
         r.title,
         r.status,
         r.current_version,
         COUNT(tc.id)::integer AS total_test_cases,
         COUNT(tc.id) FILTER (
           WHERE tc.requirement_version = r.current_version
         )::integer AS current_version_test_cases,
         COUNT(tc.id) FILTER (
           WHERE tc.requirement_version = r.current_version
             AND tc.status = 'APPROVED'
         )::integer AS current_approved_test_cases,
         COUNT(tc.id) FILTER (
           WHERE tc.requirement_version < r.current_version
             AND tc.status = 'APPROVED'
         )::integer AS outdated_approved_test_cases
       FROM requirements r
       INNER JOIN projects p ON p.id = r.project_id
       LEFT JOIN test_cases tc ON tc.requirement_id = r.id
       WHERE p.id = $1
         AND p.owner_id = $2
         AND r.status <> 'ARCHIVED'
       GROUP BY r.id, r.title, r.status, r.current_version
       ORDER BY r.created_at DESC`,
      [parsedProjectId.data, request.authenticatedUserId],
    );

    const requirements = result.rows.map((row) => {
      const currentApprovedTestCases = Number(
        row.current_approved_test_cases,
      );

      return {
        requirementId: row.id,
        title: row.title,
        status: row.status,
        currentVersion: Number(row.current_version),
        totalTestCases: Number(row.total_test_cases),
        currentVersionTestCases: Number(row.current_version_test_cases),
        currentApprovedTestCases,
        outdatedApprovedTestCases: Number(
          row.outdated_approved_test_cases,
        ),
        coverageStatus:
          currentApprovedTestCases > 0 ? "COVERED" : "UNCOVERED",
      };
    });

    return response.status(200).json({
      data: {
        requirements,
        count: requirements.length,
      },
    });
  },
);

// Create an execution run using approved test cases from current requirement versions.
testExecutionRouter.post(
  "/projects/:projectId/test-runs",
  requireAuth,
  async (request, response) => {
    const parsedProjectId = uuidSchema.safeParse(request.params.projectId);

    if (!parsedProjectId.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid project ID" },
      });
    }

    const client = await pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const projectResult = await client.query(
        `SELECT id, status
         FROM projects
         WHERE id = $1 AND owner_id = $2
         FOR UPDATE`,
        [parsedProjectId.data, request.authenticatedUserId],
      );

      const project = projectResult.rows[0];

      if (!project) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(404).json({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      }

      if (project.status !== "ACTIVE") {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "PROJECT_ARCHIVED",
            message: "Execution runs cannot be created for archived projects",
          },
        });
      }

      const eligibleCases = await client.query<{
        id: string;
        title: string;
        automation_script_id: string | null;
      }>(
        `SELECT
           tc.id,
           tc.title,
           (
             SELECT script.id
             FROM automation_scripts script
             WHERE script.test_case_id = tc.id
               AND script.approval_status = 'APPROVED'
             ORDER BY script.version DESC
             LIMIT 1
             FOR SHARE
           ) AS automation_script_id
         FROM test_cases tc
         INNER JOIN requirements r ON r.id = tc.requirement_id
         WHERE r.project_id = $1
           AND tc.status = 'APPROVED'
           AND tc.requirement_version = r.current_version
         ORDER BY tc.created_at ASC, tc.id ASC
         FOR SHARE OF tc, r`,
        [parsedProjectId.data],
      );

      const testCaseIds = eligibleCases.rows.map((row) => row.id);

      if (testCaseIds.length === 0) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "NO_ELIGIBLE_TEST_CASES",
            message:
              "No approved test cases exist for the current requirement versions",
          },
        });
      }

      const casesWithoutScripts = eligibleCases.rows
        .filter((row) => !row.automation_script_id)
        .map((row) => ({
          testCaseId: row.id,
          title: row.title,
        }));

      if (casesWithoutScripts.length > 0) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "NO_APPROVED_AUTOMATION_SCRIPTS",
            message:
              "Every eligible test case must have an approved automation script before execution",
            details: {
              testCases: casesWithoutScripts,
            },
          },
        });
      }

      const runResult = await client.query<TestRunRow>(
        `INSERT INTO test_runs (project_id, triggered_by, status)
         VALUES ($1, $2, 'QUEUED')
         RETURNING id, project_id, triggered_by, status,
                   started_at, completed_at, created_at`,
        [parsedProjectId.data, request.authenticatedUserId],
      );

      const run = runResult.rows[0];

        await client.query(
        `INSERT INTO test_results
           (test_run_id, test_case_id, automation_script_id, status)
         SELECT $1, selected.test_case_id, selected.automation_script_id, 'NOT_RUN'
         FROM unnest($2::uuid[], $3::uuid[])
           AS selected(test_case_id, automation_script_id)`,
        [
          run.id,
          eligibleCases.rows.map((row) => row.id),
          eligibleCases.rows.map((row) => row.automation_script_id),
        ],
      );

      await client.query("COMMIT");
      transactionOpen = false;

      return response.status(201).json({
        data: {
          testRun: {
            ...toTestRun(run),
            summary: {
              total: testCaseIds.length,
              passed: 0,
              failed: 0,
              skipped: 0,
              errors: 0,
              notRun: testCaseIds.length,
            },
          },
        },
      });
    } catch (error) {
      await rollbackSafely(client, transactionOpen);
      throw error;
    } finally {
      client.release();
    }
  },
);

// Start a queued execution run.
testExecutionRouter.post(
  "/test-runs/:testRunId/start",
  requireAuth,
  async (request, response) => {
    const parsedRunId = uuidSchema.safeParse(request.params.testRunId);

    if (!parsedRunId.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid test run ID" },
      });
    }

    const userId = getAuthenticatedUserId(request.authenticatedUserId);

    if (!userId) {
      return response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication is required",
        },
      });
    }

    const client = await pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const run = await getOwnedRun(
        client,
        parsedRunId.data,
        userId,
        true,
      );

      if (!run) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(404).json({
          error: {
            code: "TEST_RUN_NOT_FOUND",
            message: "Test run not found",
          },
        });
      }

      if (run.status !== "QUEUED") {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "INVALID_RUN_STATE",
            message: `Cannot start a test run with status ${run.status}`,
          },
        });
      }

      const updated = await client.query<TestRunRow>(
        `UPDATE test_runs
         SET status = 'RUNNING', started_at = NOW()
         WHERE id = $1
         RETURNING id, project_id, triggered_by, status,
                   started_at, completed_at, created_at`,
        [run.id],
      );

      await client.query("COMMIT");
      transactionOpen = false;

      return response.status(200).json({
        data: { testRun: toTestRun(updated.rows[0]) },
      });
    } catch (error) {
      await rollbackSafely(client, transactionOpen);
      throw error;
    } finally {
      client.release();
    }
  },
);

// Record the result of an individual test case.
testExecutionRouter.patch(
  "/test-runs/:testRunId/results/:resultId",
  requireAuth,
  async (request, response) => {
    const parsedRunId = uuidSchema.safeParse(request.params.testRunId);
    const parsedResultId = uuidSchema.safeParse(request.params.resultId);
    const parsedBody = resultUpdateSchema.safeParse(request.body);
    const userId = getAuthenticatedUserId(request.authenticatedUserId);

    if (
      !parsedRunId.success ||
      !parsedResultId.success ||
      !parsedBody.success
    ) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid test run ID, result ID, or result data",
          ...(parsedBody.success
            ? {}
            : { details: parsedBody.error.flatten().fieldErrors }),
        },
      });
    }

    if (!userId) {
      return response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication is required",
        },
      });
    }

    const client = await pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const run = await getOwnedRun(
        client,
        parsedRunId.data,
        userId,
        true,
      );

      if (!run) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(404).json({
          error: {
            code: "TEST_RUN_NOT_FOUND",
            message: "Test run not found",
          },
        });
      }

      if (run.status !== "RUNNING") {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "INVALID_RUN_STATE",
            message: "Results can only be updated while a test run is RUNNING",
          },
        });
      }

      const input = parsedBody.data;

      const updated = await client.query(
        `UPDATE test_results res
         SET status = $3,
             duration_ms = $4,
             error_message = $5,
             artifact_path = $6,
             executed_at = NOW()
         WHERE res.id = $1
           AND res.test_run_id = $2
           AND res.status = 'NOT_RUN'
         RETURNING res.id, res.test_case_id, res.status,
                   res.duration_ms, res.error_message,
                   res.artifact_path, res.automation_script_id,
                   res.executed_at`,
        [
          parsedResultId.data,
          run.id,
          input.status,
          input.durationMs ?? null,
          input.errorMessage ?? null,
          input.artifactPath ?? null,
        ],
      );

      if (updated.rows.length === 0) {
        const existing = await client.query(
          `SELECT id, status
           FROM test_results
           WHERE id = $1 AND test_run_id = $2`,
          [parsedResultId.data, run.id],
        );

        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        if (existing.rows.length === 0) {
          return response.status(404).json({
            error: {
              code: "TEST_RESULT_NOT_FOUND",
              message: "Test result not found for this run",
            },
          });
        }

        if (existing.rows[0].status !== "NOT_RUN") {
          return response.status(409).json({
            error: {
              code: "RESULT_ALREADY_RECORDED",
              message: "This test result has already been recorded",
            },
          });
        }

        return response.status(400).json({
          error: {
            code: "RESULT_ALREADY_RECORDED",
            message: "This test result could not be updated",
          },
        });
      }

      await client.query("COMMIT");
      transactionOpen = false;

      const row = updated.rows[0];

      return response.status(200).json({
        data: {
          result: {
            id: row.id,
            testCaseId: row.test_case_id,
            status: row.status,
            durationMs: row.duration_ms,
            errorMessage: row.error_message,
            artifactPath: row.artifact_path,
            automationScriptId: row.automation_script_id,
            executedAt: row.executed_at,
          },
        },
      });
    } catch (error) {
      await rollbackSafely(client, transactionOpen);
      throw error;
    } finally {
      client.release();
    }
  },
);

// Complete a running execution run after all results have been recorded.
testExecutionRouter.post(
  "/test-runs/:testRunId/complete",
  requireAuth,
  async (request, response) => {
    const parsedRunId = uuidSchema.safeParse(request.params.testRunId);

    if (!parsedRunId.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid test run ID",
        },
      });
    }
    const userId = getAuthenticatedUserId(request.authenticatedUserId);

    if (!userId) {
      return response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication is required",
        },
      });
    }

    const client = await pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const run = await getOwnedRun(
        client,
        parsedRunId.data,
        userId,
        true,
      );

      if (!run) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(404).json({
          error: {
            code: "TEST_RUN_NOT_FOUND",
            message: "Test run not found",
          },
        });
      }

      if (run.status !== "RUNNING") {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "INVALID_RUN_STATE",
            message: `Cannot complete a test run with status ${run.status}`,
          },
        });
      }

      const summary = await getRunSummary(client, run.id);

      if (Number(summary.not_run_count) > 0) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "INCOMPLETE_TEST_RESULTS",
            message:
              "All test results must be recorded before completing the run",
            remaining: Number(summary.not_run_count),
          },
        });
      }

      const finalStatus =
        Number(summary.failed_count) > 0 ||
        Number(summary.error_count) > 0
          ? "FAILED"
          : "PASSED";

      const updated = await client.query<TestRunRow>(
        `UPDATE test_runs
         SET status = $2, completed_at = NOW()
         WHERE id = $1
         RETURNING id, project_id, triggered_by, status,
                   started_at, completed_at, created_at`,
        [run.id, finalStatus],
      );

      const completedSummary = await getRunSummary(client, run.id);

      await client.query("COMMIT");
      transactionOpen = false;

      return response.status(200).json({
        data: {
          testRun: {
            ...toTestRun(updated.rows[0]),
            summary: toSummary(completedSummary),
          },
        },
      });
    } catch (error) {
      await rollbackSafely(client, transactionOpen);
      throw error;
    } finally {
      client.release();
    }
  },
);

// Cancel a queued or running execution run.
testExecutionRouter.post(
  "/test-runs/:testRunId/cancel",
  requireAuth,
  async (request, response) => {
    const parsedRunId = uuidSchema.safeParse(request.params.testRunId);

    if (!parsedRunId.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid test run ID",
        },
      });
    }
    const userId = getAuthenticatedUserId(request.authenticatedUserId);

    if (!userId) {
      return response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication is required",
        },
      });
    }

    const client = await pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const run = await getOwnedRun(
        client,
        parsedRunId.data,
        userId,
        true,
      );

      if (!run) {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(404).json({
          error: {
            code: "TEST_RUN_NOT_FOUND",
            message: "Test run not found",
          },
        });
      }

      if (run.status !== "QUEUED" && run.status !== "RUNNING") {
        await rollbackSafely(client, transactionOpen);
        transactionOpen = false;

        return response.status(409).json({
          error: {
            code: "INVALID_RUN_STATE",
            message: `Cannot cancel a test run with status ${run.status}`,
          },
        });
      }

      // Preserve started_at when cancelling a running run.
      // Queued runs remain unstarted.
      const updated = await client.query<TestRunRow>(
        `UPDATE test_runs
        SET status = 'CANCELLED',
            completed_at = NOW()
        WHERE id = $1
        RETURNING id, project_id, triggered_by, status,
                  started_at, completed_at, created_at`,
        [run.id],
      );

      await client.query("COMMIT");
      transactionOpen = false;

      return response.status(200).json({
        data: { testRun: toTestRun(updated.rows[0]) },
      });
    } catch (error) {
      await rollbackSafely(client, transactionOpen);
      throw error;
    } finally {
      client.release();
    }
  },
);

// List execution history for a project.
testExecutionRouter.get(
  "/projects/:projectId/test-runs",
  requireAuth,
  async (request, response) => {
    const parsedProjectId = uuidSchema.safeParse(request.params.projectId);

    if (!parsedProjectId.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid project ID" },
      });
    }

    const parsedQuery = listRunsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid execution history filters",
          details: parsedQuery.error.flatten().fieldErrors,
        },
      });
    }

    const { limit, offset } = parsedQuery.data;

    const result = await pool.query<TestRunRow>(
      `SELECT tr.id, tr.project_id, tr.triggered_by, tr.status,
              tr.started_at, tr.completed_at, tr.created_at,
              COUNT(res.id)::integer AS total_count,
              COUNT(res.id) FILTER (WHERE res.status = 'PASSED')::integer AS passed_count,
              COUNT(res.id) FILTER (WHERE res.status = 'FAILED')::integer AS failed_count,
              COUNT(res.id) FILTER (WHERE res.status = 'SKIPPED')::integer AS skipped_count,
              COUNT(res.id) FILTER (WHERE res.status = 'ERROR')::integer AS error_count,
              COUNT(res.id) FILTER (WHERE res.status = 'NOT_RUN')::integer AS not_run_count
       FROM test_runs tr
       INNER JOIN projects p ON p.id = tr.project_id
       LEFT JOIN test_results res ON res.test_run_id = tr.id
       WHERE tr.project_id = $1 AND p.owner_id = $2
       GROUP BY tr.id
       ORDER BY tr.created_at DESC
       LIMIT $3 OFFSET $4`,
      [parsedProjectId.data, request.authenticatedUserId, limit, offset],
    );

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM test_runs tr
       INNER JOIN projects p ON p.id = tr.project_id
       WHERE tr.project_id = $1 AND p.owner_id = $2`,
      [parsedProjectId.data, request.authenticatedUserId],
    );

    return response.status(200).json({
      data: {
        testRuns: result.rows.map(toTestRun),
        pagination: {
          limit,
          offset,
          count: Number(countResult.rows[0].count),
        },
      },
    });
  },
);

// Get an execution run and its individual test results.
testExecutionRouter.get(
  "/test-runs/:testRunId",
  requireAuth,
  async (request, response) => {
    const parsedRunId = uuidSchema.safeParse(request.params.testRunId);

    if (!parsedRunId.success) {
      return response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid test run ID" },
      });
    }

    const runResult = await pool.query<TestRunRow>(
      `SELECT tr.id, tr.project_id, tr.triggered_by, tr.status,
              tr.started_at, tr.completed_at, tr.created_at,
              COUNT(res.id)::integer AS total_count,
              COUNT(res.id) FILTER (WHERE res.status = 'PASSED')::integer AS passed_count,
              COUNT(res.id) FILTER (WHERE res.status = 'FAILED')::integer AS failed_count,
              COUNT(res.id) FILTER (WHERE res.status = 'SKIPPED')::integer AS skipped_count,
              COUNT(res.id) FILTER (WHERE res.status = 'ERROR')::integer AS error_count,
              COUNT(res.id) FILTER (WHERE res.status = 'NOT_RUN')::integer AS not_run_count
       FROM test_runs tr
       INNER JOIN projects p ON p.id = tr.project_id
       LEFT JOIN test_results res ON res.test_run_id = tr.id
       WHERE tr.id = $1 AND p.owner_id = $2
       GROUP BY tr.id`,
      [parsedRunId.data, request.authenticatedUserId],
    );

    const run = runResult.rows[0];

    if (!run) {
      return response.status(404).json({
        error: {
          code: "TEST_RUN_NOT_FOUND",
          message: "Test run not found",
        },
      });
    }

    const results = await pool.query<TestResultRow>(
      `SELECT res.id, res.test_case_id, res.automation_script_id, res.status,
              res.duration_ms, res.error_message, res.artifact_path, res.executed_at,
              tc.title AS test_case_title, tc.requirement_id, tc.requirement_version,
              (tc.requirement_version = r.current_version) AS is_current
       FROM test_results res
       INNER JOIN test_cases tc ON tc.id = res.test_case_id
       INNER JOIN requirements r ON r.id = tc.requirement_id
       WHERE res.test_run_id = $1
       ORDER BY tc.created_at ASC, tc.id ASC`,
      [run.id],
    );

    return response.status(200).json({
      data: {
        testRun: toTestRun(run),
        results: results.rows.map((row) => ({
          id: row.id,
          testCaseId: row.test_case_id,
          testCaseTitle: row.test_case_title,
          requirementId: row.requirement_id,
          requirementVersion: row.requirement_version,
          isCurrent: row.is_current,
          automationScriptId: row.automation_script_id,
          status: row.status,
          durationMs: row.duration_ms,
          errorMessage: row.error_message,
          artifactPath: row.artifact_path,
          executedAt: row.executed_at,
        })),
      },
    });
  },
);
