+++Debate(
	roles=[
		"Defender: argues FOR, finds supporting evidence",
		"Skeptic: finds weaknesses, demands factual evidence"
	],
	rounds={{rounds}},
	respond_to_opponent=true,
	early_stop_on_consensus=true,
	show_process=true
)

+++OutputFormat(type=markdown, sections=["Round N", "Verdict"])

{{topic}}
