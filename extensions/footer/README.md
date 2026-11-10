# footer

Replaces Pi's built-in footer with one that keeps the model readable in narrow
terminals, such as tmux on a phone.

Pi's footer puts the model to the right of the token stats. When both don't fit,
it cuts the model to whatever room is left, often a single letter. This footer
shows the same content, and when the model doesn't fit next to the stats it gets
its own right-aligned line instead (with the provider when there is room). At
widths where everything fits, the output matches Pi's footer exactly.

It mirrors Pi 1.5's footer except for routed virtual models (`model → routed`),
which extensions can't observe. Remove this extension once Pi's own footer wraps
the model.
