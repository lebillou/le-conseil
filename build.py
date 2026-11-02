"""Assemble src/ en un fichier index.html autonome (servi par GitHub Pages)."""
from pathlib import Path

root = Path(__file__).parent
shell = (root / "src/shell.html").read_text(encoding="utf-8")
engine = (root / "src/engine.js").read_text(encoding="utf-8").replace(
    'if (typeof module !== "undefined") module.exports = ENGINE;', "")
ui = (root / "src/ui.js").read_text(encoding="utf-8")
for name, code in (("engine.js", engine), ("ui.js", ui)):
    if "</script" in code.lower():
        raise SystemExit(f"{name} contient </script>, la page serait cassée")
out = shell.replace("/*ENGINE*/", engine).replace("/*UI*/", ui)
(root / "index.html").write_text(out, encoding="utf-8")
print(f"index.html : {len(out):,} octets")
