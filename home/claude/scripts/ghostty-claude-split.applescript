tell application "Ghostty"
	set t to focused terminal of selected tab of front window
	set newTerm to split t direction right
	input text "cl\n" to newTerm
end tell
