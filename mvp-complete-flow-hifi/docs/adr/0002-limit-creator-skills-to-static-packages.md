---
status: superseded by ADR-0009
---

# Limit Creator Skills to static packages

Creator-published Skill packages contain a required `SKILL.md` plus optional static text, data, templates, and raster artwork; a Skill does not need an icon. We reject scripts, binaries, executable file modes, SVG, HTML, and nested archives because preventing automatic installation scripts does not stop an instruction package from asking the model to execute bundled content later.
