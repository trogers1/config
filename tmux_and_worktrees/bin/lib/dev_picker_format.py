#!/usr/bin/env python3
"""Render picker-only columns; never change the raw identity/path snapshot."""
import pathlib
import sys
import unicodedata


MAX_NAME_WIDTH = 32


def width(*, text):
    return sum(0 if unicodedata.combining(c) else
               2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in text)


def shorten(*, text):
    if width(text=text) <= MAX_NAME_WIDTH:
        return text
    used = 0
    end = 0
    for i, character in enumerate(text):
        cells = width(text=character)
        if used + cells > MAX_NAME_WIDTH - width(text='…'):
            break
        used += cells
        end = i + 1
    return text[:end] + '…'


def render(*, raw, prefix):
    if raw and not raw.endswith('\n'):
        raise ValueError('dev inventory: snapshot must end with a newline')
    rows = [line.split('\t') for line in raw[:-1].split('\n')] if raw else []
    for number, row in enumerate(rows, 1):
        if len(row) != 5 or not all(row):
            raise ValueError(f'dev inventory: expected five nonempty fields in row {number}')
    # Git status is intentionally absent: neither picker scope needs checkout scans.
    rows = [[row[0], shorten(text=row[1]), shorten(text=row[2]), row[4]]
            for row in rows]
    labels = ['KIND', 'SESSION', 'BRANCH', 'PATH']
    widths = [max(width(text=row[i]) for row in [labels, *rows]) for i in range(3)]

    def display(*, row):
        return '  '.join(value + ' ' * (widths[i] - width(text=value))
                         for i, value in enumerate(row[:3])) + '  ' + row[3]

    return 'ID\t' + display(row=labels) + '\n' + ''.join(
        f'{prefix}{i}\t{display(row=row)}\n' for i, row in enumerate(rows, 1))


if __name__ == '__main__':
    print(render(raw=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'),
                 prefix=sys.argv[2]), end='')
