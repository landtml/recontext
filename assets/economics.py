"""Draws the two diagrams in the README's "Choosing the threshold" section, in a light and a dark variant.

Needs matplotlib. Run from the repo root: python3 assets/economics.py [preview_dir]
The inputs are the measured values quoted in the README, in thousands of tokens.
The colors follow GitHub's light and dark canvases. The SVGs carry no date or creator metadata.
"""
import math
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

F, G, E, R, W = 39.5, 1.80, 27.7, 0.7, 20      # floor, growth per turn, extra cache write, re-reads, price ratio
C = W * (E + R)                                 # cost of one shrink, in cache-read tokens
T_OPT = F + math.sqrt(2 * G * C)

THEMES = {
    'light': dict(bg='#F6F8FA', ink='#1F2328', muted='#59636E', grid='#D8DEE4', red='#CF3A3A', red_dk='#A52A2A',
                  fill='#F2B8B0', fill_alpha=0.45, blue='#2F6DB5', shrink='#7A5C55'),
    'dark': dict(bg='#151B23', ink='#D1D9E0', muted='#9198A1', grid='#2A313C', red='#F0605A', red_dk='#FF8A80',
                 fill='#F0605A', fill_alpha=0.16, blue='#6CA6F0', shrink='#C4A49C'),
}
P = THEMES['light']

for path in font_manager.findSystemFonts():
    if 'Inter-' in path or 'Inter.' in path:
        font_manager.fontManager.addfont(path)


def style():
    plt.rcParams.update({
        'font.family': ['Inter', 'DejaVu Sans'], 'font.size': 12, 'text.color': P['ink'],
        'figure.facecolor': P['bg'], 'axes.facecolor': P['bg'], 'savefig.facecolor': P['bg'],
        'axes.edgecolor': P['muted'], 'axes.labelcolor': P['muted'], 'xtick.color': P['muted'], 'ytick.color': P['muted'],
        'axes.spines.top': False, 'axes.spines.right': False, 'axes.grid': True, 'axes.axisbelow': True,
        'grid.color': P['grid'], 'grid.linewidth': 0.8, 'axes.titleweight': 'semibold', 'axes.titlesize': 14,
        'axes.titlecolor': P['ink'], 'axes.titlelocation': 'left', 'axes.titlepad': 14, 'svg.hashsalt': 'recontext',
        'legend.frameon': False, 'legend.fontsize': 11, 'legend.labelcolor': P['ink'], 'legend.handlelength': 2.4,
        'legend.columnspacing': 1.8,
    })


def legend(ax, ncol):
    """Legend under the plot, so it names each color without covering a line."""
    ax.legend(loc='upper center', bbox_to_anchor=(0.5, -0.16), ncol=ncol)


def cost(t):
    return (F + t) / 2 + C * G / (t - F)


def kfmt(axis):
    axis.set_major_formatter(lambda v, _: f'{v:.0f}k')


def cycle():
    """Context size over turns: a sawtooth between the floor F and the threshold T."""
    T, turns = 100.0, 112
    n = (T - F) / G
    xs, ys, t = [], [], 0.0
    while t < turns:
        end = min(turns, t + n)
        xs += [t, end]
        ys += [F, F + (end - t) * G]
        t = end
    fig, ax = plt.subplots(figsize=(8.6, 4.9))
    ax.plot(xs, ys, color=P['red'], lw=2.4, label='context size, turn by turn')
    ax.fill_between(xs, ys, color=P['fill'], alpha=P['fill_alpha'], lw=0, label='tokens re-read every turn')
    shrinks = [i * n for i in range(1, int(turns / n) + 1)]
    ax.plot(shrinks, [T] * len(shrinks), 'o', color=P['red_dk'], ms=6, zorder=5, label='a shrink: one-off cost C')
    ax.axhline(T, color=P['red_dk'], lw=1, ls=(0, (5, 4)), label='T: threshold, a shrink starts')
    ax.axhline(F, color=P['muted'], lw=1, ls=(0, (5, 4)), label='F: floor, context after a shrink')
    ax.annotate('', xy=(n, T + 13), xytext=(0, T + 13), arrowprops=dict(arrowstyle='<->', color=P['ink'], lw=1))
    ax.text(n / 2, T + 16, 'one cycle = (T − F) / g turns', ha='center', fontsize=11)
    ax.set(xlim=(0, turns), ylim=(0, 128), title='Context size over a long session (T = 100k)')
    ax.set_xlabel('turns', labelpad=2)
    ax.set_xticks([])
    kfmt(ax.yaxis)
    legend(ax, 2)
    return fig


def curve():
    """Cost per turn against the threshold: reading rises, shrink overhead falls, the sum has a minimum."""
    ts = [F + 0.5 + i * 0.25 for i in range(int((300 - F - 0.5) / 0.25) + 1)]
    fig, ax = plt.subplots(figsize=(8.6, 5.4))
    ax.plot(ts, [cost(t) for t in ts], color=P['red'], lw=3, label='total cost per turn')
    ax.plot(ts, [(F + t) / 2 for t in ts], color=P['blue'], lw=2, label='reading the context: (F + T) / 2')
    ax.plot(ts, [C * G / (t - F) for t in ts], color=P['shrink'], lw=2, label='shrinks, spread over a cycle: C·g / (T − F)')
    ax.axvline(F, color=P['muted'], lw=1, ls=(0, (5, 4)), label='F: floor, no room to grow')
    for t, label, color, (lx, ly) in ((T_OPT, f'cheapest\n{T_OPT:.0f}k', P['red_dk'], (68, 140)),
                                      (100, f'100k\n+{100 * (cost(100) / cost(T_OPT) - 1):.0f}%', P['ink'], (118, 140)),
                                      (167, f'167k\n+{100 * (cost(167) / cost(T_OPT) - 1):.0f}%', P['ink'], (167, cost(167) + 14))):
        ax.vlines(t, 0, cost(t), color=color, lw=1, ls=(0, (4, 4)))
        ax.plot(t, cost(t), 'o', color=color, ms=6, zorder=5)
        ax.annotate(label, xy=(t, cost(t)), xytext=(lx, ly), ha='center', va='bottom', color=color, fontsize=11,
                    weight='semibold', linespacing=1.2,
                    arrowprops=None if t == 167 else dict(arrowstyle='-', color=color, lw=0.8, shrinkA=2, shrinkB=5))
    ax.set(xlim=(30, 300), ylim=(0, 200), xlabel='threshold T: context size when a shrink starts',
           ylabel='cache-read tokens per turn', title='Cost per turn against the threshold')
    kfmt(ax.xaxis)
    kfmt(ax.yaxis)
    legend(ax, 2)
    return fig


if __name__ == '__main__':
    preview = sys.argv[1] if len(sys.argv) > 1 else None
    for theme, colors in THEMES.items():
        P = colors
        style()
        for name, draw in (('economics-cycle', cycle), ('economics-cost', curve)):
            fig = draw()
            fig.tight_layout()
            fig.savefig(f'assets/{name}-{theme}.svg', metadata={'Date': None, 'Creator': None, 'Format': None, 'Type': None})
            if preview:
                fig.savefig(f'{preview}/{name}-{theme}.png', dpi=150)
            plt.close(fig)
    print(f'C = {C:.0f}k, T* = {T_OPT:.1f}k, cost(100k) = +{100 * (cost(100) / cost(T_OPT) - 1):.1f}%')
