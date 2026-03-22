+++Debate(
	roles=[
		"Defender: argues FOR the position using materialist dialectical reasoning (Cornforth). Each argument must: (1) state material conditions — concrete facts about resources, infrastructure, constraints; (2) identify contradictions — structural tensions where one condition undermines another; (3) trace dependencies — explicit causal chains showing what requires what; (4) propose resolution by changing conditions, not by redistributing effort within unchanged conditions.",
		"Skeptic: targets the strongest claim, not the weakest; demands sources. Uses materialist dialectical reasoning (Cornforth). Each objection must: (1) challenge the stated material conditions with counter-evidence; (2) expose contradictions the Defender missed or downplayed; (3) show broken dependencies — where A requires B but B is absent or undermined; (4) argue that the proposed resolution fails to change the conditions that matter."
	],
	rounds={{rounds}},
	respond_to_opponent=true,
	early_stop_on_consensus=true,
	early_stop_condition="Skeptic cannot raise a substantive new objection",
	show_process=true,
	evidence=search_each_round,
	cite_sources=inline_links
)

+++

DialecticalMethod(
	description="Materialist dialectics (Cornforth). Every argument by both roles must follow this structure:",
	steps=[
		"1. Material conditions: state concrete facts — what exists, what quantities, what costs, what infrastructure, what political constraints. No abstractions without grounding.",
		"2. Contradictions: identify structural tensions — where one condition undermines another, where progress in one area creates regress in another, where means conflict with ends.",
		"3. Dependencies: trace causal chains explicitly — if A requires B, state B's status. If B is absent, A cannot proceed regardless of effort on A.",
		"4. Resolution by changing conditions: propose changes to material conditions (policy, infrastructure, technology, institutions), not mere reallocation of effort within unchanged conditions."
	],
	enforcement="If an argument lacks any of these four elements, it is incomplete. The opposing role must call out the missing element."
)

RoundStructure(
	depth="3-5 paragraphs per role per round",
	progression=[
		"Round 1: state the material conditions of the topic domain. Define terms grounded in measurable quantities. Defender identifies the principal contradiction the position addresses. Skeptic identifies a different principal contradiction or challenges the framing.",
		"Round 2: respond to opponent's strongest point by tracing its dependencies — show where the causal chain holds or breaks. Advance new ground by identifying contradictions the opponent missed. Both sides must cite concrete data.",
		"Round 3: no new arguments. Rebut by showing whether proposed resolutions actually change conditions or merely redistribute effort. Synthesize: which contradictions remain unresolved, which dependencies are unmet, what conditions would need to change for resolution."
	]
)

VerdictFormat(
	sections=[
		"Summary of strongest arguments each side (grounded in material conditions)",
		"Key contradictions identified by each side",
		"Unresolved dependencies and what conditions would need to change",
		"Assessment with confidence 1-10"
	]
)

OutputFormat(type=markdown, sections=["## Round N", "## Verdict"])

{{topic}}
