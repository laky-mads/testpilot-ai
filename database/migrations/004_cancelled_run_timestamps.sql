
BEGIN;

ALTER TABLE public.test_runs
DROP CONSTRAINT IF EXISTS test_runs_check;

ALTER TABLE public.test_runs
ADD CONSTRAINT test_runs_check
CHECK (
  completed_at IS NULL
  OR started_at IS NOT NULL
  OR status = 'CANCELLED'
);

COMMIT;
