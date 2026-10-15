## Summary

<!-- What changed and why. Link the related issue if there is one. -->

## Checklist

- [ ] Checks run and passing:
  - [ ] `claude plugin validate .`
  - [ ] `claude plugin test .`
  - [ ] `npx -p typescript tsc -p . --noEmit`
  - [ ] `python -m pytest tests/python`
- [ ] Smoke test, if launch or lockdown changed (see DEVELOPING.md). Results pasted below:

  <!-- Paste the smoke test output here, or write "N/A" if launch and lockdown are unchanged. -->

- [ ] CHANGELOG entry added (or not needed for this change)
- [ ] Docs updated (README, DEVELOPING.md, or CONTRIBUTING.md) if behaviour or setup changed
