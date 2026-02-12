+++Debate(
	roles=[
		"Защитник: приводит аргументы ЗА, ищет доказательства",
		"Скептик: ищет слабые места, требует фактические свидетельства"
	],
	rounds={{rounds}},
	respond_to_opponent=true,
	early_stop_on_consensus=true,
	show_process=true
)

+++OutputFormat(type=markdown, sections=["Раунд N", "Вердикт"])

{{topic}}
