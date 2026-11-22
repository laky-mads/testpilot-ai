import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bot, CheckCircle2, Download, FileText, LoaderCircle, Search, Upload, WandSparkles } from "lucide-react";
import { apiRequest } from "./api";
import { useAuth } from "./auth";

type Project = { id: string; name: string; description: string | null; status: "ACTIVE" | "ARCHIVED" };
type Requirement = { id: string; projectId: string; title: string; content: string; sourceFileName: string | null; status: string; createdAt: string; updatedAt: string };
type TestCase = { id: string; requirementId: string; title: string; description: string | null; preconditions: string | null; steps: Array<{ action: string; expectedResult: string }>; expectedResult: string; priority: string; testType: string; status: "DRAFT" | "REVIEW" | "APPROVED" | "REJECTED" };
type Analysis = { overallAssessment?: string; summary?: string; [key: string]: unknown };

type AutomationScript = {
  id: string;
  test_case_id: string;
  name: string;
  framework: string;
  language: string;
  source_code: string;
  version: number;
  approval_status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
  updated_at: string;
};

type Data<T> = { data: T };
type CoverageSummary = {
  totalRequirements: number;
  coveredRequirements: number;
  uncoveredRequirements: number;
  coveragePercentage: number;
  currentApprovedTestCases: number;
  outdatedApprovedTestCases: number;
};

type RequirementCoverage = {
  requirementId: string;
  title: string;
  status: string;
  currentVersion: number;
  totalTestCases: number;
  currentVersionTestCases: number;
  currentApprovedTestCases: number;
  outdatedApprovedTestCases: number;
  coverageStatus: "COVERED" | "UNCOVERED";
};

type ExecutionSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  notRun: number;
};

type TestRun = {
  id: string;
  projectId: string;
  triggeredBy: string | null;
  status: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "CANCELLED";
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  summary: ExecutionSummary;
};

type TestRunResult = {
  id: string;
  testCaseId: string;
  testCaseTitle: string;
  requirementId: string;
  requirementVersion: number;
  isCurrent: boolean;
  automationScriptId: string | null;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  artifactPath: string | null;
  executedAt: string | null;
};
const field = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export default function ProjectWorkspace() {
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [automationScripts, setAutomationScripts] = useState<Record<string, AutomationScript[]>>({});
  const [expandedScriptId, setExpandedScriptId] = useState("");
  const { projectId = "" } = useParams();
  const { accessToken, user, logout } = useAuth();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [caseSearch, setCaseSearch] = useState("");
  const [caseStatus, setCaseStatus] = useState("ALL");
  const [casePriority, setCasePriority] = useState("ALL");
  const [coverage, setCoverage] = useState<CoverageSummary | null>(null);
  const [coverageDetails, setCoverageDetails] = useState<RequirementCoverage[]>([]);
  const [testRuns, setTestRuns] = useState<TestRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState("");
  const [runResults, setRunResults] = useState<Record<string, TestRunResult[]>>({});
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState("");

  const selected = useMemo(() => requirements.find(item => item.id === selectedId) ?? null, [requirements, selectedId]);

  async function loadProject() {
    const [projectResult, requirementsResult] = await Promise.all([
      apiRequest<Data<{ project: Project }>>(`/api/projects/${projectId}`, {}, accessToken),
      apiRequest<Data<{ requirements: Requirement[] }>>(`/api/projects/${projectId}/requirements`, {}, accessToken),
    ]);
    setProject(projectResult.data.project);
    setRequirements(requirementsResult.data.requirements);
    setSelectedId(current => current || requirementsResult.data.requirements[0]?.id || "");
  }

  async function loadArtifacts(requirementId: string) {
    setError("");
    const [casesResult, analysisResult] = await Promise.all([
      apiRequest<Data<{ testCases: TestCase[] }>>(`/api/requirements/${requirementId}/test-cases`, {}, accessToken),
      apiRequest<Data<{ analysis: Analysis }>>(`/api/requirements/${requirementId}/analysis`, {}, accessToken).catch(() => null),
    ]);
    setTestCases(casesResult.data.testCases);
    setAnalysis(analysisResult?.data.analysis ?? null);
  }

  async function loadReports() {
    setReportBusy(true);
    setReportError("");

    try {
      const [coverageResult, detailsResult, runsResult] = await Promise.all([
        apiRequest<Data<{ coverage: CoverageSummary }>>(
          `/api/projects/${projectId}/coverage`,
          {},
          accessToken,
        ),
        apiRequest<Data<{ requirements: RequirementCoverage[] }>>(
          `/api/projects/${projectId}/coverage/details`,
          {},
          accessToken,
        ),
        apiRequest<Data<{ testRuns: TestRun[]; pagination: { limit: number; offset: number; count: number } }>>(
          `/api/projects/${projectId}/test-runs?limit=20&offset=0`,
          {},
          accessToken,
        ),
      ]);

      setCoverage(coverageResult.data.coverage);
      setCoverageDetails(detailsResult.data.requirements);
      setTestRuns(runsResult.data.testRuns);
    } catch (err) {
      setReportError(
        err instanceof Error ? err.message : "Unable to load project reports",
      );
    } finally {
      setReportBusy(false);
    }
  }

  async function toggleRunDetails(testRunId: string) {
    if (expandedRunId === testRunId) {
      setExpandedRunId("");
      return;
    }

    setExpandedRunId(testRunId);

    if (runResults[testRunId]) {
      return;
    }

    try {
      const result = await apiRequest<
        Data<{ testRun: TestRun; results: TestRunResult[] }>
      >(`/api/test-runs/${testRunId}`, {}, accessToken);

      setRunResults(current => ({
        ...current,
        [testRunId]: result.data.results,
      }));
    } catch (err) {
      setReportError(
        err instanceof Error ? err.message : "Unable to load execution details",
      );
    }
  }

  useEffect(() => { void loadProject().catch(err => setError(err instanceof Error ? err.message : "Unable to load project")); }, [projectId, accessToken]);
  useEffect(() => {
    void loadReports();
  }, [projectId, accessToken]);
  useEffect(() => { if (selectedId) void loadArtifacts(selectedId).catch(err => setError(err instanceof Error ? err.message : "Unable to load requirement artifacts")); else { setTestCases([]); setAnalysis(null); } }, [selectedId, accessToken]);

  async function createRequirement(event: FormEvent) {
    event.preventDefault(); setBusy("save"); setError(""); setNotice("");
    try {
      const result = await apiRequest<Data<{ requirement: Requirement }>>(`/api/projects/${projectId}/requirements`, { method: "POST", body: JSON.stringify({ title, content, sourceFileName: file?.name }) }, accessToken);
      setRequirements(items => [result.data.requirement, ...items]); setSelectedId(result.data.requirement.id); setTitle(""); setContent(""); setFile(null); setNotice("Requirement saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save requirement"); }
    finally { setBusy(""); }
  }

  async function uploadAndPreview() {
    if (!file) return;
    setBusy("upload"); setError(""); setNotice("");
    try {
      const body = new FormData(); body.append("file", file);
      const result = await apiRequest<Data<{ fileName: string; extractedText: string }>>(`/api/projects/${projectId}/requirements/preview`, { method: "POST", body }, accessToken);
      setTitle(file.name.replace(/\.[^.]+$/, "").slice(0, 200)); setContent(result.data.extractedText); setNotice("Document text extracted. Review it before saving the requirement.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to extract document text"); }
    finally { setBusy(""); }
  }

  async function runAnalysis() {
    if (!selected) return;
    setBusy("analyze"); setError(""); setNotice("");
    try {
      const result = await apiRequest<Data<{ analysis: Analysis }>>(`/api/requirements/${selected.id}/analyze`, { method: "POST" }, accessToken);
      setAnalysis(result.data.analysis); setRequirements(items => items.map(item => item.id === selected.id ? { ...item, status: "ANALYZED" } : item)); setNotice("AI analysis completed. Review the findings before generating test cases.");
    } catch (err) { setError(err instanceof Error ? err.message : "Analysis failed"); }
    finally { setBusy(""); }
  }

  async function generateCases() {
    if (!selected) return;
    setBusy("generate"); setError(""); setNotice("");
    try {
      await apiRequest(`/api/requirements/${selected.id}/test-cases/generate`, { method: "POST" }, accessToken);
      await loadArtifacts(selected.id); setNotice("Test cases generated as drafts. Review each case before approval.");
    } catch (err) { setError(err instanceof Error ? err.message : "Test case generation failed"); }
    finally { setBusy(""); }
  }

  async function reviewCase(testCase: TestCase, status: TestCase["status"]) {
    setBusy(testCase.id); setError("");
    try {
      await apiRequest(`/api/test-cases/${testCase.id}`, { method: "PATCH", body: JSON.stringify({ status }) }, accessToken);
      setTestCases(items => items.map(item => item.id === testCase.id ? { ...item, status } : item));
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update test case"); }
    finally { setBusy(""); }
  }


  async function loadAutomationScripts(testCaseId: string) {
    try {
      const result = await apiRequest<
        Data<{ scripts: AutomationScript[] }>
      >(
        `/api/test-cases/${testCaseId}/automation-scripts`,
        {},
        accessToken,
      );

      setAutomationScripts(current => ({
        ...current,
        [testCaseId]: result.data.scripts,
      }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load automation scripts",
      );
    }
  }

  async function generateAutomationScript(testCase: TestCase) {
    setBusy(`script-${testCase.id}`);
    setError("");
    setNotice("");

    try {
      await apiRequest(
        `/api/test-cases/${testCase.id}/automation-scripts/generate`,
        { method: "POST" },
        accessToken,
      );

      await loadAutomationScripts(testCase.id);
      setNotice("Automation script generated. Review it before approval.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Script generation failed");
    } finally {
      setBusy("");
    }
  }

  async function reviewAutomationScript(
    script: AutomationScript,
    approvalStatus: "APPROVED" | "REJECTED",
  ) {
    setBusy(`review-script-${script.id}`);
    setError("");
    setNotice("");

    try {
      const result = await apiRequest<
        Data<{ script: AutomationScript }>
      >(
        `/api/automation-scripts/${script.id}/review`,
        {
          method: "PATCH",
          body: JSON.stringify({ approvalStatus }),
        },
        accessToken,
      );

      setAutomationScripts(current => ({
        ...current,
        [script.test_case_id]: (current[script.test_case_id] ?? []).map(item =>
          item.id === script.id ? result.data.script : item,
        ),
      }));

      setNotice(`Automation script ${approvalStatus.toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to review script");
    } finally {
      setBusy("");
    }
  }

  async function toggleScriptDetails(testCaseId: string) {
    if (expandedScriptId === testCaseId) {
      setExpandedScriptId("");
      return;
    }

    setExpandedScriptId(testCaseId);

    if (!automationScripts[testCaseId]) {
      await loadAutomationScripts(testCaseId);
    }
  }


  const approvedCount = testCases.filter(item => item.status === "APPROVED").length;
  const visibleTestCases = testCases.filter(item => {
    const query = caseSearch.trim().toLowerCase();
    const matchesText = !query || [item.title, item.description ?? "", item.preconditions ?? "", item.expectedResult, item.testType].some(value => value.toLowerCase().includes(query));
    return matchesText && (caseStatus === "ALL" || item.status === caseStatus) && (casePriority === "ALL" || item.priority === casePriority);
  });

  function exportTestCases() {
    if (!testCases.length) return;
    const columns = ["ID", "Title", "Description", "Preconditions", "Steps", "Expected Result", "Priority", "Test Type", "Status"];
    const escapeCsv = (value: unknown) => {
      const text = Array.isArray(value) ? value.map(step => typeof step === "string" ? step : `${step.action}: ${step.expectedResult}`).join(" | ") : String(value ?? "");
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = testCases.map(item => [item.id, item.title, item.description, item.preconditions, item.steps, item.expectedResult, item.priority, item.testType, item.status]);
    const csv = [columns, ...rows].map(row => row.map(escapeCsv).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `testpilot-${project?.name?.trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "project"}-test-cases.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function exportExecutionRun(run: TestRun) {
    const results = runResults[run.id];

    if (!results?.length) return;

    const columns = [
      "Run ID",
      "Run Status",
      "Run Created At",
      "Run Started At",
      "Run Completed At",
      "Test Case ID",
      "Test Case Title",
      "Requirement ID",
      "Requirement Version",
      "Requirement Version Status",
      "Result Status",
      "Duration (ms)",
      "Error Message",
      "Artifact Path",
      "Executed At",
    ];

    const escapeCsv = (value: unknown) => {
      const text = String(value ?? "");

      const safeText = /^[\t\r ]*[=+\-@]/.test(text)
        ? `'${text}`
        : text;

      return `"${safeText.replace(/"/g, '""')}"`;
    };

    const rows = results.map(result => [
      run.id,
      run.status,
      run.createdAt,
      run.startedAt,
      run.completedAt,
      result.testCaseId,
      result.testCaseTitle,
      result.requirementId,
      result.requirementVersion,
      result.isCurrent ? "CURRENT" : "OUTDATED",
      result.status,
      result.durationMs,
      result.errorMessage,
      result.artifactPath,
      result.executedAt,
    ]);

    const csv = [columns, ...rows]
      .map(row => row.map(escapeCsv).join(","))
      .join("\r\n");

    const blob = new Blob(["\uFEFF", csv], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    const projectSlug =
      project?.name?.trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase() ||
      "project";

    anchor.href = url;
    anchor.download = `testpilot-${projectSlug}-run-${run.id.slice(0, 8)}.csv`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);
  }

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4 md:px-8">
      <div className="flex items-center gap-3"><Link to="/" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Back to projects"><ArrowLeft size={18}/></Link><div><p className="text-xs text-slate-400">TestPilot AI / Project workspace</p><h1 className="font-semibold">{project?.name ?? "Loading project…"}</h1></div></div>
      <div className="flex items-center gap-3"><span className="hidden text-sm text-slate-500 sm:block">{user?.displayName}</span><button onClick={() => { logout(); navigate("/login"); }} className="text-sm font-medium text-slate-600">Sign out</button></div>
    </header>
    <main className="mx-auto grid max-w-7xl gap-6 px-5 py-7 lg:grid-cols-[340px_minmax(0,1fr)] md:px-8">
      <aside className="space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-2"><FileText size={18} className="text-blue-700"/><h2 className="font-semibold">Requirements</h2></div><p className="mt-1 text-xs text-slate-500">Add a requirement or select one to continue.</p>
          <div className="mt-4 space-y-2">{requirements.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} className={`w-full rounded-lg border p-3 text-left ${selectedId === item.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-1 block text-[11px] text-slate-500">{item.status} · {new Date(item.updatedAt).toLocaleDateString()}</span></button>)}{requirements.length === 0 && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">No requirements yet.</p>}</div>
        </section>
        <form onSubmit={createRequirement} className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">New requirement</h2>
          <label className="mt-4 block text-xs font-medium text-slate-600">Title<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} className={field} placeholder="User login and access"/></label>
          <label className="mt-3 block text-xs font-medium text-slate-600">Requirement text<textarea required minLength={1} maxLength={50000} rows={5} value={content} onChange={e=>setContent(e.target.value)} className={field} placeholder="Describe expected product behaviour…"/></label>
          <label className="mt-3 block text-xs font-medium text-slate-600">Upload source document <span className="font-normal text-slate-400">(PDF, DOCX, TXT · max 10 MB)</span><input type="file" accept=".pdf,.docx,.txt" onChange={e=>setFile(e.target.files?.[0] ?? null)} className="mt-2 block w-full text-xs text-slate-600"/></label>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!file || !!busy} onClick={() => void uploadAndPreview()} className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-50"><Upload size={14}/>{busy === "upload" ? "Extracting…" : "Extract text"}</button><button disabled={!!busy} className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy === "save" ? "Saving…" : "Save requirement"}</button></div>
        </form>
      </aside>
      <section className="space-y-5">
        {reportError && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {reportError}
          </p>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Requirement Coverage</h2>
              <p className="mt-1 text-xs text-slate-500">
                Coverage based on approved test cases for current requirement versions.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadReports()}
              disabled={reportBusy}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              {reportBusy ? "Refreshing…" : "Refresh reports"}
            </button>
          </div>

          {reportBusy && !coverage ? (
            <p className="mt-5 text-sm text-slate-500">Loading coverage data…</p>
          ) : coverage ? (
            <>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg bg-blue-50 p-4">
                  <p className="text-xs text-blue-700">Coverage</p>
                  <p className="mt-1 text-2xl font-semibold text-blue-900">
                    {coverage.coveragePercentage.toFixed(2)}%
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-50 p-4">
                  <p className="text-xs text-emerald-700">Covered requirements</p>
                  <p className="mt-1 text-2xl font-semibold text-emerald-900">
                    {coverage.coveredRequirements}
                  </p>
                </div>
                <div className="rounded-lg bg-amber-50 p-4">
                  <p className="text-xs text-amber-700">Uncovered requirements</p>
                  <p className="mt-1 text-2xl font-semibold text-amber-900">
                    {coverage.uncoveredRequirements}
                  </p>
                </div>
                <div className="rounded-lg bg-slate-100 p-4">
                  <p className="text-xs text-slate-600">Approved test cases</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">
                    {coverage.currentApprovedTestCases}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {coverage.outdatedApprovedTestCases} outdated
                  </p>
                </div>
              </div>

              <div className="mt-5">
                <div className="mb-2 flex justify-between text-xs">
                  <span className="font-medium text-slate-600">Overall coverage</span>
                  <span className="font-semibold text-slate-800">
                    {coverage.coveredRequirements} / {coverage.totalRequirements}
                  </span>
                </div>
                <div
                  className="h-2.5 overflow-hidden rounded-full bg-slate-100"
                  role="progressbar"
                  aria-label="Requirement coverage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={coverage.coveragePercentage}
                >
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all"
                    style={{
                      width: `${Math.min(100, Math.max(0, coverage.coveragePercentage))}%`,
                    }}
                  />
                </div>
              </div>

              <div className="mt-6">
                <h3 className="text-sm font-semibold">Requirement breakdown</h3>
                {coverageDetails.length === 0 ? (
                  <p className="mt-3 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
                    No active requirements available for coverage analysis.
                  </p>
                ) : (
                  <div className="mt-3 divide-y divide-slate-100">
                    {coverageDetails.map(item => (
                      <div
                        key={item.requirementId}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">
                            {item.title}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Version {item.currentVersion} · {item.currentApprovedTestCases} approved current-version cases
                            {item.outdatedApprovedTestCases > 0
                              ? ` · ${item.outdatedApprovedTestCases} outdated`
                              : ""}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                            item.coverageStatus === "COVERED"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {item.coverageStatus}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-500">
              Coverage information is not available yet.
            </p>
          )}
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Execution History</h2>
              <p className="mt-1 text-xs text-slate-500">
                Review previous test runs and their individual results.
              </p>
            </div>
            <span className="text-xs text-slate-500">
              {testRuns.length} recent runs
            </span>
          </div>

          {testRuns.length === 0 ? (
            <div className="mt-4 rounded-lg bg-slate-50 p-6 text-center">
              <p className="text-sm font-medium text-slate-700">No execution history yet</p>
              <p className="mt-1 text-xs text-slate-500">
                Execution runs will appear here when test runs are created.
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {testRuns.map(run => (
                <article key={run.id} className="rounded-lg border border-slate-200">
                  <button
                    type="button"
                    onClick={() => void toggleRunDetails(run.id)}
                    aria-expanded={expandedRunId === run.id}
                    className="w-full p-4 text-left hover:bg-slate-50"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          Run {run.id.slice(0, 8)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Created {new Date(run.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                        run.status === "PASSED"
                          ? "bg-emerald-50 text-emerald-700"
                          : run.status === "FAILED"
                            ? "bg-red-50 text-red-700"
                            : run.status === "RUNNING"
                              ? "bg-blue-50 text-blue-700"
                              : run.status === "CANCELLED"
                                ? "bg-slate-100 text-slate-600"
                                : "bg-amber-50 text-amber-700"
                      }`}>
                        {run.status}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                      {[
                        ["Total", run.summary.total],
                        ["Passed", run.summary.passed],
                        ["Failed", run.summary.failed],
                        ["Skipped", run.summary.skipped],
                        ["Errors", run.summary.errors],
                        ["Not run", run.summary.notRun],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-md bg-slate-50 p-2">
                          <p className="text-[10px] text-slate-500">{label}</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">{value}</p>
                        </div>
                      ))}
                    </div>

                    <p className="mt-3 text-xs font-medium text-blue-700">
                      {expandedRunId === run.id ? "Hide details ↑" : "View test results ↓"}
                    </p>
                  </button>

                  {expandedRunId === run.id && (
                    <div className="border-t border-slate-200 p-4">
                      {runResults[run.id]?.length > 0 && (
                        <div className="mb-3 flex justify-end">
                          <button
                            type="button"
                            onClick={() => exportExecutionRun(run)}
                            className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <Download size={14} />
                            Export Run CSV
                          </button>
                        </div>
                      )}
                      {!runResults[run.id] ? (
                        <p className="text-xs text-slate-500">Loading test results…</p>
                      ) : runResults[run.id].length === 0 ? (
                        <p className="text-xs text-slate-500">No test results found for this run.</p>
                      ) : (
                        <div className="space-y-2">
                          {runResults[run.id].map(result => (
                            <div key={result.id} className="rounded-lg bg-slate-50 p-3">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-slate-800">
                                    {result.testCaseTitle}
                                  </p>
                                  <p className="mt-1 text-[10px] text-slate-500">
                                    Requirement version {result.requirementVersion}
                                    {result.isCurrent ? " · Current" : " · Outdated"}
                                  </p>
                                </div>
                                <span className="text-[10px] font-semibold text-slate-600">
                                  {result.status}
                                </span>
                              </div>

                              <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500">
                                {result.durationMs !== null && (
                                  <span>Duration: {result.durationMs} ms</span>
                                )}
                                {result.executedAt && (
                                  <span>Executed: {new Date(result.executedAt).toLocaleString()}</span>
                                )}
                              </div>

                              {result.errorMessage && (
                                <p className="mt-2 whitespace-pre-wrap rounded-md bg-red-50 p-2 text-xs text-red-700">
                                  {result.errorMessage}
                                </p>
                              )}

                              {result.artifactPath && (
                                <p className="mt-2 break-all text-[10px] text-slate-500">
                                  Artifact: {result.artifactPath}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p>}
        {!selected ? <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center"><FileText className="mx-auto text-slate-300" size={30}/><h2 className="mt-3 font-semibold">Select a requirement</h2><p className="mt-1 text-sm text-slate-500">Your AI analysis and generated test cases will appear here.</p></div> : <>
          <section className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold tracking-wide text-blue-700">REQUIREMENT</p><h2 className="mt-1 text-lg font-semibold">{selected.title}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{selected.content}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold">{selected.status}</span></div><div className="mt-5 flex flex-wrap gap-2"><button disabled={!!busy || selected.status === "APPROVED" || selected.status === "ARCHIVED"} onClick={() => void runAnalysis()} className="flex items-center gap-2 rounded-lg bg-indigo-700 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50"><Bot size={15}/>{busy === "analyze" ? "Analyzing…" : "Analyze with AI"}</button><button disabled={!!busy || !analysis} onClick={() => void generateCases()} className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-semibold text-blue-800 disabled:opacity-50"><WandSparkles size={15}/>{busy === "generate" ? "Generating…" : "Generate test cases"}</button></div></section>
          {analysis && <section className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-5"><div className="flex items-center gap-2"><Bot size={18} className="text-indigo-700"/><h3 className="font-semibold">AI analysis</h3><span className="ml-auto text-[10px] font-semibold text-indigo-700">HUMAN REVIEW REQUIRED</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{String(analysis.overallAssessment ?? analysis.summary ?? "Analysis completed. Review the structured findings below.")}</p><details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-indigo-800">View structured analysis</summary><pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-white p-3 text-xs">{JSON.stringify(analysis, null, 2)}</pre></details></section>}
          <section className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">Generated test cases</h3><p className="mt-1 text-xs text-slate-500">{testCases.length} cases · {approvedCount} approved</p></div><span className="text-xs text-slate-400">Review before use</span></div>
            <div className="mt-4 flex flex-wrap gap-2">
              <label className="relative min-w-[180px] flex-1"><Search size={14} className="absolute left-3 top-3 text-slate-400"/><input value={caseSearch} onChange={e=>setCaseSearch(e.target.value)} placeholder="Search test cases…" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-xs"/></label>
              <select value={caseStatus} onChange={e=>setCaseStatus(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs"><option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="REVIEW">In review</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select>
              <select value={casePriority} onChange={e=>setCasePriority(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs"><option value="ALL">All priorities</option><option value="CRITICAL">Critical</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select>
              <button onClick={exportTestCases} disabled={!testCases.length} className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"><Download size={14}/>Export CSV</button>
            </div>
            <div className="mt-4 space-y-3">
              {visibleTestCases.map((item, index) => (
                <article
                  key={item.id}
                  className="rounded-lg border border-slate-200 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400">
                        TC-{String(index + 1).padStart(3, "0")} · {item.testType} · {item.priority}
                      </p>
                      <h4 className="mt-1 text-sm font-semibold">{item.title}</h4>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        {item.description}
                      </p>
                    </div>

                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold">
                      {item.status}
                    </span>
                  </div>

                  <p className="mt-3 text-xs font-semibold text-slate-600">
                    Preconditions
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.preconditions || "None specified"}
                  </p>

                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-slate-600">
                    {item.steps?.map((step, stepIndex) => (
                      <li key={stepIndex}>
                        {typeof step === "string"
                          ? step
                          : `${step.action} — ${step.expectedResult}`}
                      </li>
                    ))}
                  </ol>

                  <p className="mt-3 text-xs font-semibold text-slate-600">
                    Expected result
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.expectedResult}
                  </p>

                  {/* Test case review actions */}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {item.status !== "APPROVED" && (
                      <button
                        disabled={!!busy}
                        onClick={() => void reviewCase(item, "APPROVED")}
                        className="flex items-center gap-1 rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:opacity-50"
                      >
                        <CheckCircle2 size={13} />
                        Approve
                      </button>
                    )}

                    {item.status !== "REVIEW" && item.status !== "APPROVED" && (
                      <button
                        disabled={!!busy}
                        onClick={() => void reviewCase(item, "REVIEW")}
                        className="rounded-md bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 disabled:opacity-50"
                      >
                        Mark for review
                      </button>
                    )}

                    {item.status !== "REJECTED" && (
                      <button
                        disabled={!!busy}
                        onClick={() => void reviewCase(item, "REJECTED")}
                        className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    )}
                  </div>

                  {/* Automation scripts */}
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h5 className="text-xs font-semibold text-slate-800">
                          Automation Scripts
                        </h5>
                        <p className="mt-1 text-[10px] text-slate-500">
                          Playwright · TypeScript
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {item.status === "APPROVED" && (
                          <button
                            disabled={!!busy}
                            onClick={() => void generateAutomationScript(item)}
                            className="rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 disabled:opacity-50"
                          >
                            {busy === `script-${item.id}`
                              ? "Generating…"
                              : "Generate script"}
                          </button>
                        )}

                        <button
                          disabled={!!busy}
                          onClick={() => void toggleScriptDetails(item.id)}
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
                        >
                          {expandedScriptId === item.id ? "Hide scripts" : "View scripts"}
                          {automationScripts[item.id]
                            ? ` (${automationScripts[item.id].length})`
                            : ""}
                        </button>
                      </div>
                    </div>

                    {expandedScriptId === item.id && (
                      <div className="mt-3 space-y-3">
                        {!automationScripts[item.id]?.length ? (
                          <p className="rounded-lg bg-slate-50 p-4 text-center text-xs text-slate-500">
                            No automation scripts generated yet.
                            {item.status === "APPROVED"
                              ? " Generate a script to get started."
                              : " Approve this test case before generating a script."}
                          </p>
                        ) : (
                          automationScripts[item.id].map(script => (
                            <article
                              key={script.id}
                              className="rounded-lg border border-slate-200 p-3"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs font-semibold text-slate-800">
                                    {script.name}
                                  </p>
                                  <p className="mt-1 text-[10px] text-slate-500">
                                    Version {script.version} · {script.framework} · {script.language}
                                  </p>
                                  <p className="mt-1 text-[10px] text-slate-400">
                                    Created: {new Date(script.created_at).toLocaleString()}
                                  </p>
                                </div>

                                <span
                                  className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                                    script.approval_status === "APPROVED"
                                      ? "bg-emerald-50 text-emerald-700"
                                      : script.approval_status === "REJECTED"
                                        ? "bg-red-50 text-red-700"
                                        : "bg-amber-50 text-amber-700"
                                  }`}
                                >
                                  {script.approval_status}
                                </span>
                              </div>

                              <details className="mt-3">
                                <summary className="cursor-pointer text-xs font-semibold text-blue-700">
                                  View TypeScript source
                                </summary>
                                <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                                  <code>{script.source_code}</code>
                                </pre>
                              </details>

                              {script.approval_status === "PENDING" && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    disabled={!!busy}
                                    onClick={() =>
                                      void reviewAutomationScript(script, "APPROVED")
                                    }
                                    className="rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:opacity-50"
                                  >
                                    Approve script
                                  </button>

                                  <button
                                    disabled={!!busy}
                                    onClick={() =>
                                      void reviewAutomationScript(script, "REJECTED")
                                    }
                                    className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                                  >
                                    Reject script
                                  </button>
                                </div>
                              )}
                            </article>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}

              {testCases.length > 0 && visibleTestCases.length === 0 && (
                <p className="rounded-lg bg-slate-50 p-5 text-center text-sm text-slate-500">
                  No test cases match the selected filters.
                </p>
              )}

              {testCases.length === 0 && (
                <div className="rounded-lg bg-slate-50 p-8 text-center">
                  <LoaderCircle className="mx-auto text-slate-300" size={22} />
                  <p className="mt-2 text-sm text-slate-500">
                    No test cases yet. Complete an analysis, then generate test cases.
                  </p>
                </div>
              )}
            </div>
          </section>
        </>}
      </section>
    </main>
  </div>;
}
