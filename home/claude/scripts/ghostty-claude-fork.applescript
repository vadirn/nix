tell application "Ghostty"
	set t to focused terminal of selected tab of front window
	set cwd to working directory of t

	-- Find the claude session ID for this directory
	set sid to do shell script "for f in ~/.claude/sessions/*.json; do
		[ -f \"$f\" ] || continue
		pid=$(jq -r '.pid // empty' \"$f\" 2>/dev/null) || continue
		[ -z \"$pid\" ] && continue
		kill -0 \"$pid\" 2>/dev/null || continue
		fcwd=$(jq -r '.cwd // empty' \"$f\" 2>/dev/null)
		[ \"$fcwd\" = " & quoted form of cwd & " ] || continue
		jq -r '.sessionId // empty' \"$f\" 2>/dev/null
		break
	done"

	set newTerm to split t direction right
	if sid is not "" then
		input text ("clf " & sid & "\n") to newTerm
	else
		input text "cln\n" to newTerm
	end if
end tell
