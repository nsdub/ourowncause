"""Near-duplicate check: Jaccard similarity over word 5-shingles."""
import re

SHINGLE = 5


def _shingles(text: str) -> set[tuple[str, ...]]:
    words = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return {tuple(words[i:i + SHINGLE]) for i in range(len(words) - SHINGLE + 1)}


def similar(text: str, archive: dict[str, str], threshold: float = 0.6) -> list[tuple[str, float]]:
    """Return (slug, score) pairs with score >= threshold, highest first."""
    mine = _shingles(text)
    out = []
    for slug, other_text in archive.items():
        other = _shingles(other_text)
        union = mine | other
        score = round(len(mine & other) / len(union), 3) if mine and other else 0.0
        if score >= threshold:
            out.append((slug, score))
    out.sort(key=lambda t: (-t[1], t[0]))
    return out
