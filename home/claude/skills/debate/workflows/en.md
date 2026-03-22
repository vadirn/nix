+++Debate(
	roles=["Defender: argues FOR using dialectical reasoning (Cornforth). Labels each dialectical element explicitly: [CONDITIONS], [CONTRADICTION], [DEPENDENCY], [RESOLUTION]. Every claim cites measurable data. Resolution must change material conditions, never redistribute effort.",
		"Skeptic: attacks the strongest claim. Labels elements the same way. Exposes missing conditions with counter-data, traces broken dependencies to their root, demands causal chains. If any element is missing or ungrounded, names it and refuses to proceed until addressed."],
	rounds={{rounds}}, respond_to_opponent=true, early_stop_on_consensus=true,
	evidence=search_each_round, cite_sources=inline_links
)+++

Round 1: [CONDITIONS] State material conditions as quantities (costs, capacities, timelines, populations). Define every term via measurement. Defender: identify principal contradiction with evidence showing two conditions undermining each other. Skeptic: present alternative contradiction or reframe with counter-evidence.
Round 2: Respond to opponent's strongest point. [DEPENDENCY] Trace at least one explicit chain: A requires B, B requires C, show which link is broken and cite evidence. Advance new contradictions grounded in data from Round 1.
Round 3: No new arguments. [RESOLUTION] For each proposed resolution, state which material condition changes and what measurable outcome follows. Flag any resolution that redistributes effort without changing conditions. Synthesize: list unresolved contradictions, unmet dependencies, and conditions needed.

Depth: 3-5 paragraphs per role per round. Every paragraph must contain at least one labeled dialectical element with supporting data. Opponent must call out any unlabeled or ungrounded claim.

Verdict: strongest arguments (with data citations), key contradictions (structural, not opinion), unresolved dependencies (with broken links named), assessment with confidence 1-10.

Output: markdown with ## Round N and ## Verdict sections.

{{topic}}
