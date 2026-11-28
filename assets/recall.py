"""Draws the two diagrams in the README's "Virtual context window and recall" section, light and dark.

Needs matplotlib. Run from the repo root: python3 assets/recall.py [preview_dir]
The inputs are the aggregate values quoted in the README. No session data is read.
The colors follow GitHub's light and dark canvases. The SVGs carry no date or creator metadata.
"""
import sys
sys.dont_write_bytecode = True

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

import economics as eco

N, BEFORE, AFTER, DROP = 61, 121, 50, 73       # shrinks, median context before / after (k), mean tokens freed (k)
HELD = {'0.2.12': 50.0, '0.3.0': 90.4}          # share of needed exact items the handoff holds (%)


def window():
    """Active context (a sawtooth) against everything the session has covered (a rising line)."""
    xs, active, covered = [0.0], [AFTER], [AFTER]
    for i in range(N):
        xs += [i + 1, i + 1]
        active += [BEFORE, AFTER]
        covered += [AFTER + (i + 1) * DROP] * 2
    ax = plt.subplots(figsize=(8.6, 4.9))[1]
    ax.plot(xs, covered, color=eco.P['blue'], lw=2.4, label='virtual window: everything recall can reach')
    ax.plot(xs, active, color=eco.P['red'], lw=1.6, label='active context: what the model reads')
    ax.fill_between(xs, active, 30, color=eco.P['fill'], alpha=eco.P['fill_alpha'], lw=0)
    ax.axhline(200, color=eco.P['muted'], lw=1, ls=(0, (5, 4)), label='a 200k real window')
    ax.set_yscale('log')
    ax.set(xlim=(0, N), ylim=(30, 8000), xlabel='shrinks', ylabel='tokens (log scale)',
           title=f'One long session: {N} shrinks, about 4.5M tokens reachable')
    ax.set_yticks([50, 100, 200, 500, 1000, 2000, 5000])
    ax.yaxis.set_major_formatter(lambda v, _: f'{v / 1000:.0f}M' if v >= 1000 else f'{v:.0f}k')
    ax.yaxis.set_minor_formatter(lambda v, _: '')
    eco.legend(ax, 2)
    return ax.figure


def tiers():
    """Where a needed exact fact is found after a shrink, before and after the tiered index."""
    ax = plt.subplots(figsize=(8.6, 3.6))[1]
    names = list(HELD)
    held = [HELD[n] for n in names]
    rest = [100 - h for h in held]
    ax.barh(names, held, color=eco.P['red'], height=0.55, label='in the handoff: no tool call')
    ax.barh(names[1:], rest[1:], left=held[1:], color=eco.P['blue'], height=0.55,
            label='exact lookup in recall: code, no model call')
    ax.barh(names[:1], rest[:1], left=held[:1], color=eco.P['muted'], alpha=0.35, height=0.55,
            label='not in the handoff: a Haiku search of the archive')
    for y, h in enumerate(held):
        ax.text(h - 2, y, f'{h:.1f}%', ha='right', va='center', color=eco.P['bg'], weight='semibold')
    ax.set(xlim=(0, 100), title='Where a needed exact fact is found after a shrink')
    ax.xaxis.set_major_formatter(lambda v, _: f'{v:.0f}%')
    ax.invert_yaxis()
    ax.grid(axis='y', visible=False)
    ax.legend(loc='upper center', bbox_to_anchor=(0.5, -0.2), ncol=2)
    return ax.figure


if __name__ == '__main__':
    preview = sys.argv[1] if len(sys.argv) > 1 else None
    for theme, colors in eco.THEMES.items():
        eco.P = colors
        eco.style()
        for name, draw in (('recall-window', window), ('recall-tiers', tiers)):
            fig = draw()
            fig.tight_layout()
            fig.savefig(f'assets/{name}-{theme}.svg', metadata={'Date': None, 'Creator': None, 'Format': None, 'Type': None})
            if preview:
                fig.savefig(f'{preview}/{name}-{theme}.png', dpi=150)
            plt.close(fig)
