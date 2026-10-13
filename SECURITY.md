# Reporting a problem

The one failure that matters most in Styx is a **leak**: data that should have
been removed shows up in an output file. Examples: a parameter name or value, a
text line you did not tick, an embedded file, or a message from a group you
switched off.

If you find one, please report it privately rather than in a public issue:
GitHub, this repository, Security tab, "Report a vulnerability".

Include the preset or exported preset JSON, the message or string that leaked,
and, if you can share it, a log that shows the problem. Do not send logs you are
not allowed to share; a description of the message types in the log is often
enough to reproduce it.

Other bugs and requests go in the normal issue tracker.
