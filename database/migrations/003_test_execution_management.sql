BEGIN;

ALTER TABLE public.test_results
DROP CONSTRAINT IF EXISTS test_results_status_check;

ALTER TABLE public.test_results
ADD CONSTRAINT test_results_status_check
CHECK (
  status IN (
    'NOT_RUN',
    'PASSED',
    'FAILED',
    'SKIPPED',
    'ERROR'
  )
);

COMMIT;
