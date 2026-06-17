# Hero animation for the README.
#
# Story arc (~24s, punchy):
#   1. Launch against a public Grist doc — no API key.
#   2. Open a multi-pane page; the card pane tracks the cursor (linking).
#   3. From the page picker, press s to warp to the whole-site document list.
#   4. Open a different document.
#   5. Rapid-fire through all eleven themes with T, landing on the goat.
#   6. Reopen the page in the goat theme; let the goat wander; quit.
#
# Two gotchas, both because in the grid every printable key edits the cell
# under the cursor:
#   - Theme cycling (T) and the site switch (s) only work from a picker, so
#     the tape escapes to the page picker before pressing them.
#   - Doc choice in step 4 is by position in the site's "most recently
#     updated" list, so re-pace the Down presses if you re-record later.
#
# Render from the repo root with:  vhs docs/demo/demo.tape

Output docs/demo/demo.gif
Output docs/demo/demo.mp4

Require grist-console

Set Shell "bash"
Set FontSize 14
Set Width 1100
Set Height 620
Set Padding 20
Set TypingSpeed 25ms
Set Framerate 24
Set Theme "Aardvark Blue"

Hide
Type "clear" Enter
Sleep 300ms
Show

# 1. Launch against a public template — no key, no setup.
Type "grist-console https://templates.getgrist.com/5iMYwmESm33J/Rental-Management"
Sleep 400ms
Enter
Sleep 2300ms

# 2. Open Apartments (a multi-pane page). The card pane below tracks the
#    cursor — section linking.
Down@180ms 1
Sleep 350ms
Enter
Sleep 1800ms
Down@260ms 2
Sleep 550ms
Right@230ms 3
Sleep 900ms

# 3. Back to the page picker, then warp to the whole-site document list.
Escape
Sleep 500ms
Type "s"
Sleep 1900ms

# 4. Open a different document (5 down from the top — the U.S. National
#    Park Database).
Down@170ms 5
Sleep 400ms
Enter
Sleep 1900ms
Enter
Sleep 1400ms

# 5. Back to the picker; rip through all eleven themes with T.
#    9 presses: default → visicalc → lotus → dos → matrix → c64 →
#    amber → paper → rainbow → goat.
Escape
Sleep 550ms
Type@220ms "TTTTTTTT"
Sleep 200ms
Type "T"
Sleep 800ms

# 6. Reopen the page in the goat theme; let the goat wander, then quit.
Enter
Sleep 2800ms
Escape
Sleep 350ms
Type "q"
Sleep 400ms
