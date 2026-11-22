# State matrix

Serves Force 3, domain coverage. A state-space claim says "for every step S and restore R, outcome O". Tests usually cover the happy path and a few chosen crashes, so most cells stay unexamined.

Run it for a state-space claim.

## Steps

1. **Rows** are the protocol's steps, in order. Take them from the code's state machine or step table, not from memory.
2. **Columns** say which side is restored to an earlier point or crashed: one side, the other, or both.
3. **Expectations first.** Write each cell's expected outcome before any run: success, or a named refusal that a doc or reply table states. A refusal no doc names is a finding.
4. **Only a run fills a cell.** Use the repo's cell fixture (crux: `restorePoint` in `test/service-door.ts`). Per cell: drive to step S, restore side R, continue, and compare the outcome with the expectation.
5. **A state set by hand is weaker.** A cell reached by writing state directly tests the response, not that the protocol can reach that state. Mark such a cell so.
6. **No cheap fixture:** mark the cells unrun and defer the fixture, with a reason. Never fill a cell by reading code.

## Record

Render the matrix as a table under the section's Matrix line:

```markdown
**Matrix:** rows are steps, columns are the restored side; each cell is ok, `<refusal>`, or unrun.

| Step | <side A> restored | <side B> restored | both restored |
| ---- | ----------------- | ----------------- | ------------- |
| <S1> | ok | `<refusal>` | unrun |
```

A matrix that spans sessions keeps its unrun cells in the section. They mark where the next pass resumes.
