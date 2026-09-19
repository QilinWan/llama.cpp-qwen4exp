import { describe, expect, it } from 'vitest';
import { remark } from 'remark';
import remarkMath from 'remark-math';
import { remarkMathReclassify } from '$lib/components/app/content/MarkdownContent/plugins/remark/math-reclassify';

/** Runtime builders keep fixtures free of source-escaping ambiguity. */
const B = '\\';
const cmd = (n: string) => B + n;
const tag = (n: string) => B + 'tag{' + n + '}';
const I = (s: string) => '$' + s + '$';
const D = (s: string) => '$$' + s + '$$';

function treeOf(md: string) {
	const processor = remark().use(remarkMath).use(remarkMathReclassify);

	return processor.runSync(processor.parse(md));
}

function nodeTypes(node: unknown): string[] {
	const out: string[] = [];

	(function walk(n: unknown) {
		if (n && typeof n === 'object') {
			const any = n as { type?: string; children?: unknown[] };

			if (any.type) {
				out.push(any.type);
			}

			(any.children ?? []).forEach(walk);
		}
	})(node);

	return out;
}

describe('remarkMathReclassify', () => {
	it('promotes a lone single-line display block at root', () => {
		const tree = treeOf(['before', '', D('E=mc^2 ' + tag('1')), '', 'after'].join('\n'));
		const types = nodeTypes(tree);

		expect(types).toContain('math');
		expect(types).not.toContain('inlineMath');
	});

	it('promotes a lone single-line display block in a list item', () => {
		const tree = treeOf(['- step', '', '  ' + D('x=y ' + tag('2'))].join('\n'));
		const types = nodeTypes(tree);

		expect(types).toContain('math');
	});

	it('promotes a lone single-line display block in a blockquote', () => {
		const tree = treeOf('> ' + D('x=1 ' + tag('3')));
		const types = nodeTypes(tree);

		expect(types).toContain('math');
	});

	it('promotes a lone inline-math paragraph too', () => {
		const tree = treeOf(['text', '', I('a=b')].join('\n'));
		const types = nodeTypes(tree);

		expect(types).toContain('math');
	});

	it('keeps math mixed with prose inline', () => {
		const tree = treeOf('text ' + D('x=1 ' + tag('4')) + ' tail');
		const types = nodeTypes(tree);

		expect(types).toContain('inlineMath');
		expect(types).not.toContain('math');
	});

	it('keeps two adjacent math lines inline (ambiguous intent)', () => {
		const tree = treeOf(D('a=1') + '\n' + D('b=2'));
		const types = nodeTypes(tree);

		expect(types.filter((t) => t === 'math')).toHaveLength(0);
	});

	it('keeps table-cell math inline (no flow content in cells)', () => {
		const tree = treeOf(['| a | b |', '| - | - |', '| ' + I('x' + tag('1')) + ' | y |'].join('\n'));
		const types = nodeTypes(tree);

		expect(types).toContain('inlineMath');
	});

	it('preserves the math value verbatim on promotion', () => {
		const value = cmd('alpha') + '=' + cmd('beta') + ' ' + tag('9');
		const tree = treeOf(D(value)) as { children: unknown[] };
		const math = (tree.children as Array<{ type: string; value?: string }>).find((c) => c.type === 'math');

		expect(math?.value).toBe(value);
	});

	it('leaves an already-fenced display block untouched', () => {
		const tree = treeOf(['$$', cmd('begin') + '{aligned}' + 'x&=1' + cmd('end') + '{aligned}', '$$'].join('\n'));
		const types = nodeTypes(tree);

		expect(types).toContain('math');
	});
});
