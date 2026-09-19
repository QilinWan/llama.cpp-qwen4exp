import { describe, expect, it } from 'vitest';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkMathReclassify } from '$lib/components/app/content/MarkdownContent/plugins/remark/math-reclassify';
import { rehypeKatexRobust } from '$lib/components/app/content/MarkdownContent/plugins/rehype/katex-robust';
import { remarkLiteralHtml } from '$lib/components/app/content/MarkdownContent/plugins/remark/literal-html';
import { preprocessLaTeX } from '$lib/utils/latex-protection';

/**
 * Full red-text regression matrix for the v2 math pipeline (remark-math +
 * remarkMathReclassify + rehypeKatexRobust, production plugin order, with
 * preprocessLaTeX in front). LaTeX is composed at runtime from explicit
 * builders so no fixture depends on source escaping:
 *   B = one backslash; cmd/tag build commands; I(x) inline $x$;
 *   D(x) single-line display; DLINE(x) fenced display.
 *
 * Hard invariants on EVERY case (streaming prefixes included): the render
 * never throws and the output never contains KaTeX red error markup
 * (katex-error class / #cc0000).
 */

const B = '\\';
const F = String.fromCharCode(96, 96, 96);
const cmd = (n: string) => B + n;
const tag = (n: string) => B + 'tag{' + n + '}';
const I = (s: string) => '$' + s + '$';
const D = (s: string) => '$$' + s + '$$';
const DLINE = (s: string) => ['$$', s, '$$'].join('\n');

/** Mirror of the production math pipeline (MarkdownContent.svelte). */
function renderMarkdown(md: string): string {
	const processor = remark()
		.use(remarkGfm)
		.use(remarkMath)
		.use(remarkMathReclassify)
		.use(remarkBreaks)
		.use(remarkLiteralHtml)
		.use(remarkRehype)
		.use(rehypeKatexRobust)
		.use(rehypeStringify, { allowDangerousHtml: true });

	return String(processor.processSync(preprocessLaTeX(md)));
}

const noRed = (html: string) => {
	expect(html).not.toContain('katex-error');
	expect(html.toLowerCase()).not.toContain('cc0000');
};
const rendered = (html: string) => html.includes('class="katex"');
const display = (html: string) => html.includes('katex-display') || html.includes('math-display');
const unrendered = (html: string) => html.includes('katex-unrendered');

// The three incident formulas from the production screenshot.
const eq1 = cmd('angle') + ' BDC=' + cmd('angle') + ' BDE+' + cmd('angle') + ' EBC=' + cmd('gamma') + '+' + cmd('angle') + ' EBC, ' + cmd('angle') + ' BCD=180^' + cmd('circ') + '-' + cmd('gamma') + '=90^' + cmd('circ') + '-' + cmd('gamma');
const eq2 = cmd('sin') + cmd('angle') + ' ACD=' + cmd('frac') + '{EF}{CF}' + cmd('Rightarrow') + ' CF=' + cmd('frac') + '{1}{' + cmd('sin') + '(30^' + cmd('circ') + '-' + cmd('gamma') + ')}';
const eq3 = cmd('frac') + '{CF}{' + cmd('sin') + cmd('angle') + ' BFC}=' + cmd('frac') + '{BF}{' + cmd('sin') + cmd('angle') + ' BCF}' + cmd('Rightarrow') + ' CF=' + cmd('frac') + '{5' + cmd('cos') + '(30^' + cmd('circ') + '+' + cmd('gamma') + ')}{' + cmd('sin') + ' 2' + cmd('gamma') + '}';

interface Case {
	name: string;
	md: string;
	assert?: (html: string) => void;
}

const cases: Case[] = [
	// incident: single-line display with \tag (previously red)
	{ name: 'eq1 single-line with tag (screenshot)', md: ['x', '', D(' ' + eq1 + ' ' + tag('1')), '', 'y'].join('\n'), assert: (h) => { expect(display(h)); expect(rendered(h)); expect(h).toContain('(1)'); } },
	{ name: 'eq2 single-line with tag', md: ['关系一：', '', D(' ' + eq2 + ' ' + tag('2'))].join('\n'), assert: (h) => { expect(display(h)); expect(h).toContain('(2)'); } },
	{ name: 'eq3 single-line with tag', md: ['关系二：', '', D(' ' + eq3 + ' ' + tag('3'))].join('\n'), assert: (h) => { expect(display(h)); expect(h).toContain('(3)'); } },
	// promotion shapes
	{ name: 'single-line no tag', md: D('E=mc^2'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'fenced display with tag line', md: ['$$', cmd('begin') + '{aligned}' + 'x&=1' + cmd('end') + '{aligned}', tag('5'), '$$'].join('\n'), assert: (h) => { expect(display(h)); expect(h).toContain('(5)'); } },
	{ name: 'lone math in own paragraph promotes too', md: ['text', '', I('a+b=c')].join('\n'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'blockquote lone', md: '> ' + D('x=1 ' + tag('3')), assert: (h) => { expect(display(h)); expect(h).toContain('(3)'); } },
	{ name: 'list item lone', md: ['- step', '', '  ' + D('x=y ' + tag('2'))].join('\n'), assert: (h) => { expect(display(h)); expect(h).toContain('(2)'); } },
	{ name: 'root 4-space indent stays code (documented limitation)', md: ['para', '', '    ' + D('x=1')].join('\n'), assert: (h) => { expect(h).toContain('<pre>'); } },
	// inline must stay inline
	{ name: 'inline in sentence with tag -> qquad never display', md: 'see ' + I(cmd('sin') + ' x = 1 ' + tag('7')) + ' here', assert: (h) => { expect(rendered(h)); expect(h).toContain('(7)'); expect(h).not.toContain('katex-display'); } },
	{ name: 'single-line display mid-sentence with tag', md: 'pre ' + D('a=b ' + tag('8')) + ' post', assert: (h) => { expect(rendered(h)); expect(h).toContain('(8)'); expect(h).not.toContain('katex-display'); } },
	{ name: 'align mid-sentence never promoted', md: 'text ' + D(cmd('begin') + '{align}' + 'x&=1' + cmd('end') + '{align}') + ' tail', assert: (h) => { expect(unrendered(h)); expect(h).not.toContain('katex-display'); } },
	{ name: 'table cell with tag', md: ['| a | b |', '| - | - |', '| ' + I('x' + tag('1')) + ' | y |'].join('\n'), assert: (h) => { expect(rendered(h)); expect(h).toContain('(1)'); } },
	// multi-tag and invisible-command recovery
	{ name: 'two tags same block', md: D(cmd('sin') + ' x = 1 ' + tag('2') + ' ' + tag('3')), assert: (h) => { expect(display(h)); expect(h).toContain('(2)'); expect(h).toContain('(3)'); } },
	{ name: 'label inside align stripped', md: D(cmd('begin') + '{align}' + 'x &= 1 ' + cmd('label') + '{eq:x}' + cmd('end') + '{align}'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'nonumber stripped', md: D(cmd('cos') + ' x ' + cmd('nonumber')), assert: (h) => expect(rendered(h)) },
	{ name: 'equation env stripped', md: D(cmd('begin') + '{equation}' + 'a+b=c' + cmd('end') + '{equation}'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'multline maps to gathered', md: DLINE(cmd('begin') + '{multline}' + '\na = b ' + B + B + '\n+ c\n' + cmd('end') + '{multline}'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'tag inside aligned keeps number as qquad', md: DLINE(cmd('begin') + '{aligned}' + '\nx&=1 ' + tag('5') + '\n' + cmd('end') + '{aligned}'), assert: (h) => { expect(display(h)); expect(h).toContain('(5)'); } },
	{ name: 'aligned single-line with trailing tag', md: D(cmd('begin') + '{aligned}' + 'a&=b ' + B + B + ' c&=d' + cmd('end') + '{aligned} ' + tag('6')), assert: (h) => { expect(display(h)); expect(h).toContain('(6)'); } },
	// macros: aliases, mhchem, unknown
	{ name: 'mhchem inline', md: '2 ' + I(cmd('ce') + '{H2 + O2 -> 2H2O}'), assert: (h) => expect(rendered(h)) },
	{ name: 'mhchem display fenced', md: DLINE(cmd('ce') + '{CaCO3 -> CaO + CO2}'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'alias Implies', md: D('A ' + cmd('Implies') + ' B'), assert: (h) => expect(rendered(h)) },
	{ name: 'alias xRightarrow', md: D('A ' + cmd('xRightarrow') + ' B'), assert: (h) => expect(rendered(h)) },
	{ name: 'unknown macro keeps source in gray', md: D(cmd('definecolor') + '{myred}{rgb}{1,0,0} x'), assert: (h) => { expect(unrendered(h)); expect(h).toContain('definecolor'); } },
	{ name: 'undefined cmd inline gray not red', md: 'text ' + I(cmd('frobnicate') + '{y}') + ' tail', assert: (h) => { expect(unrendered(h)); expect(h).toContain('frobnicate'); } },
	// structural errors
	{ name: 'left-right mismatch', md: D(cmd('left') + '](x'), assert: (h) => expect(unrendered(h)) },
	{ name: 'double subscript', md: D('a_1_2'), assert: (h) => expect(unrendered(h)) },
	{ name: 'newline cmd', md: D('a' + cmd('newline') + 'b'), assert: (h) => expect(rendered(h) || unrendered(h)) },
	// dollar-sign semantics
	{ name: 'currency sentence keeps text renders math', md: 'Price $5 and $$50 total plus $x^2$ math', assert: (h) => { expect(rendered(h)); expect(h).toContain('$$50'); } },
	{ name: 'unclosed display renders as text', md: ['text', '', '$$', cmd('int') + '_0^1 x ' + cmd('d') + 'x'].join('\n'), assert: (h) => { expect(h).toContain('x'); expect(h).not.toContain('katex-display'); } },
	{ name: 'math fence renders display', md: [F + 'math', cmd('int') + ' x ' + cmd('d') + 'x = ' + cmd('frac') + '{1}{2}x^2', F].join('\n'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'python fence with dollars stays code', md: [F + 'python', 'x = 5 # $$ not math $$', F].join('\n'), assert: (h) => expect(h).toContain('<pre>') },
	// misc legit math
	{ name: 'CJK inside math', md: '角度: ' + I(cmd('theta') + '=30^' + cmd('circ')), assert: (h) => expect(rendered(h)) },
	{ name: 'boxed display', md: D(cmd('boxed') + '{CF=2' + cmd('sqrt') + '{7}}'), assert: (h) => { expect(display(h)); expect(h).toContain('CF'); } },
	{ name: 'cases env', md: D(cmd('begin') + '{cases}' + 'x,&x>0' + B + B + '0,&x' + cmd('le') + '0' + cmd('end') + '{cases}'), assert: (h) => { expect(display(h)); expect(rendered(h)); } },
	{ name: 'left brace array inline', md: I(cmd('left') + B + '{' + cmd('begin') + '{array}{cc}1&2' + B + B + '3&4' + cmd('end') + '{array}' + cmd('right') + '.'), assert: (h) => expect(rendered(h)) },
	{ name: 'empty fenced display', md: DLINE('') }
];

describe('katex v2 red-text regression matrix', () => {
	for (const c of cases) {
		it(c.name, () => {
			let html = '';
			expect(() => {
				html = renderMarkdown(c.md);
			}).not.toThrow();
			noRed(html);
			c.assert?.(html);
		});
	}

	// Streaming robustness: every prefix of every case renders without
	// throwing and without any red markup.
	for (const c of cases) {
		it('stream prefixes clean: ' + c.name, () => {
			for (let i = 1; i <= c.md.length; i += 1) {
				let html = '';
				expect(() => {
					html = renderMarkdown(c.md.slice(0, i));
				}).not.toThrow();
				noRed(html);
			}
		});
	}
});
