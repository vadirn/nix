+++Debate(
	roles=[
		"Defender: argues FOR, finds supporting evidence, steelmans the position",
		"Skeptic: targets the strongest claim, not the weakest; demands sources"
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

RoundStructure(
	depth="2-4 paragraphs per role per round",
	progression=[
		"Round 1: core positions, define terms",
		"Round 2-N: respond to opponent's strongest point first, then advance new ground",
		"Final round: no new arguments, only rebuttals and synthesis"
	]
)

VerdictFormat(
	sections=["Summary of strongest arguments each side", "Where both sides agree", "Unresolved tensions", "Assessment with confidence 1-10"]
)

OutputFormat(type=markdown, sections=["## Round N", "## Verdict"])

{{topic}}
