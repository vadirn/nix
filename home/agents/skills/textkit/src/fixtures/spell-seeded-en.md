The pipeline recieves each note from the inbox and dose a quick triage before anything else. Blocks that carry seperate concerns are split apart, and the [[render router]] then decide which sections to preserve.

Its important that the `--tau 0.5` threshold stay untouched: the routing predicate depend on it. We tried loosing the bound once, and teh results was worse.
