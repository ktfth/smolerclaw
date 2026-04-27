# Fix Bookmark Test Flakiness

The test `updateBookmark updates updatedAt timestamp` is failing intermittently (likely due to sub-millisecond execution).

## Goals

- Fix the flakiness in `tests/bookmarks.test.ts`.
- Ensure `updateBookmark` correctly updates the timestamp.

## Checklist

- [x] Reproduce the issue (or understand why it fails).
- [x] Modify the test to be more robust (add delay).
- [x] Verify the fix locally.
- [x] Run tests multiple times to ensure stability.

## Verification

- Test results from `bun test` passed locally 5 times in a row.
- `updateBookmark updates updatedAt timestamp` now consistently passes with a 2ms delay.

## Notes

- `new Date().toISOString()` includes milliseconds.
- If `saveBookmark` and `updateBookmark` run too fast, they might get the same millisecond.
- Added a 2ms delay in the test to ensure timestamp difference.
