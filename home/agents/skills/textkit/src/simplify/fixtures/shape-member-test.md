# Card ingress: the deferred strands and the shape of the DSL

The pipeline turns captured web references into terse atomic cards. Capture is solved and nothing consumes it.

Two items deferred as separate strands so they don't swallow the note: fetch adapters (firecrawl covers articles, defuddle covers x.com/reddit, plus pointer resolution for tweets that link out) and card-collection hygiene (the `superseded` flag is defined but unused on cards).

The staging DSL is the other open question. Build the DSL outward from the operations that consume it, not top-down as a taxonomy, or it becomes ornament.

A deterministic scan measures the source before the pass. The scan strips fenced code, skips every list item, and measures both delimiters.
