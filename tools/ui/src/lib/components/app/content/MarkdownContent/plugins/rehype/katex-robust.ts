import katex from 'katex';
import 'katex/contrib/mhchem';
import type { MacroMap } from 'katex';
import type { Element, ElementContent, Root } from 'hast';
import { toText } from 'hast-util-to-text';
import type { Plugin } from 'unified';
import { visitParents } from 'unist-util-visit-parents';

/**
 * Mode-preserving robust KaTeX renderer — a drop-in replacement for
 * `rehype-katex` with graceful, HONEST failure recovery.
 *
 * Stock rehype-katex paints every failure in KaTeX's red errorColor:
 * a ParseError echoes the whole block as red raw source, and an undefined
 * control sequence leaks red inline fragments. This plugin never renders
 * red (invariant: no `katex-error` class and no `#cc0000` in output):
 *
 *  1. fast path renders the source untouched in the node's NATURAL mode
 *     (inline stays inline, display stays display — we never re-classify
 *     here; the remark-side `remarkMathReclassify` plugin owns semantics);
 *  2. on failure we retry content-preserving sanitizations in order —
 *     dropping invisible `\\label`/`\\nonumber`/`\\notag` and unsupported
 *     `equation`/`multline` wrappers, then rewriting `\\tag{n}` to
 *     `\\qquad(n)` (in display mode the FIRST tag is kept as a real tag,
 *     additional tags become \\qquad) — always in the SAME mode, so a failed
 *     inline formula can never explode into a display block mid-sentence,
 *     and an equation number never silently disappears (prose references
 *     like "by (2)" keep resolving);
 *  3. if nothing parses, the source degrades to neutral monospace text
 *     (`span.katex-unrendered`) with the parse error in a tooltip.
 *
 * Common hallucinated macros are legalised through an alias macro map, and
 * the mhchem contrib is registered so `\\ce{...}`/`\\pu{...}` render instead
 * of erroring.
 *
 * Math-node detection mirrors rehype-katex: nodes carrying the
 * `math-inline` / `math-display` classes from remark-math, or
 * ```math fenced code blocks (language-math inside <pre>, display mode).
 */

/** Class applied when no valid rendering could be produced (neutral, not red). */
export const KATEX_UNRENDERED_CLASS = 'katex-unrendered';

/** Class applied when rendering only succeeded after sanitization. */
export const KATEX_RECOVERED_CLASS = 'katex-recovered';

/** Lightweight counters for diagnostics (dev tooling; harmless in prod). */
export const katexRobustStats = { fast: 0, recovered: 0, unrendered: 0 };

/** A `\\tag{...}` / `\\tag*{...}` command; group 1 is the tag body. */
const TAG_COMMAND_REGEXP = /\\tag\s*\*?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** Invisible or unsupported wrappers stripped before retrying. */
const LABEL_COMMAND_REGEXP = /\\label\s*\{(?:[^{}]|\{[^{}]*\})*\}/g;
const NOTAG_REGEXP = /\\(?:nonumber|notag)\b/g;
const EQUATION_ENV_REGEXP = /\\begin\{equation\*?\}\s*|\s*\\end\{equation\*?\}/g;

/**
 * Common LLM-hallucinated or non-KaTeX control sequences mapped to the
 * closest valid KaTeX macro. Only names that KaTeX does NOT define are
 * listed, so nothing legitimate is shadowed.
 */
export const KATEX_MACRO_ALIASES: MacroMap = {
	'\\Implies': '\\implies',
	'\\Implied': '\\impliedby',
	'\\implied': '\\impliedby',
	'\\xLongrightarrow': '\\Longrightarrow',
	'\\xRightarrow': '\\Longrightarrow',
	'\\xLeftarrow': '\\Longleftarrow',
	'\\LongRightArrow': '\\longrightarrow',
	'\\LongLeftArrow': '\\longleftarrow',
	'\\Boxed': '\\boxed',
	'\\Substack': '\\substack',
	'\\Frac': '\\frac',
	'\\Dfrac': '\\dfrac',
	'\\Tfrac': '\\tfrac',
	'\\Text': '\\text'
};

function isMathElement(element: Element): boolean {
	const className = element.properties?.className;

	if (!Array.isArray(className)) {
		return false;
	}

	return (
		className.includes('language-math') ||
		className.includes('math-display') ||
		className.includes('math-inline')
	);
}

/**
 * Content-preserving sanitization: removes commands that produce no visible
 * output (or wrappers KaTeX does not implement) without changing anything
 * the reader sees. `multline` maps to `gathered` (closest KaTeX analogue).
 */
function sanitizeInvisible(source: string): string {
	let out = source.replace(LABEL_COMMAND_REGEXP, '').replace(NOTAG_REGEXP, '').replace(EQUATION_ENV_REGEXP, '');

	if (out.includes('\\begin{multline')) {
		out = out.replace(/\\begin\{multline\*?\}/g, '\\begin{gathered}').replace(/\\end\{multline\*?\}/g, '\\end{gathered}');
	}

	return out;
}

/**
 * Rewrites `\\tag{...}` commands. In display mode the first tag is kept as
 * a real (rendered) tag and later tags become \\qquad(n); in inline mode
 * every tag becomes \\qquad(n) (KaTeX forbids tags inline, but the NUMBER
 * must survive for prose cross-references).
 */
function transformTags(source: string, keepFirstTag: boolean): string {
	let seen = false;

	return source.replace(new RegExp(TAG_COMMAND_REGEXP.source, 'g'), (match: string, body: string) => {
		if (keepFirstTag && !seen) {
			seen = true;

			return match;
		}

		const inner = String(body).trim();

		return inner ? `\\qquad(${inner})` : '\\qquad';
	});
}

interface RenderResult {
	html: string | null;
	error: string | null;
}

function tryRender(source: string, displayMode: boolean): RenderResult {
	try {
		return {
			html: katex.renderToString(source, {
				displayMode,
				throwOnError: true,
				strict: 'ignore',
				macros: KATEX_MACRO_ALIASES
			}),
			error: null
		};
	} catch (error) {
		return { html: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Ordered, mode-preserving retry candidates (fast-path source first). */
function buildCandidates(source: string, displayMode: boolean): string[] {
	const sanitized = sanitizeInvisible(source);
	const candidates = [source, sanitized];

	if (displayMode) {
		candidates.push(transformTags(sanitized, true));
		candidates.push(transformTags(sanitized, false));
	} else {
		candidates.push(transformTags(sanitized, false));
	}

	return [...new Set(candidates)];
}

function unrenderedSpan(source: string, error: string | null): Element {
	return {
		type: 'element',
		tagName: 'span',
		properties: {
			className: [KATEX_UNRENDERED_CLASS],
			title: error ? `KaTeX could not render this formula: ${error}` : 'KaTeX could not render this formula'
		},
		children: [{ type: 'text', value: source }]
	};
}

export const rehypeKatexRobust: Plugin<[], Root> = () => {
	return (tree: Root) => {
		visitParents(tree, 'element', (element: Element, parents: Element[]) => {
			if (!isMathElement(element)) {
				return;
			}

			const classes = element.properties?.className as string[];
			const languageMath = classes.includes('language-math');

			// NOTE: mdast-util-math also puts "language-math" on INLINE nodes, so
			// display mode must come from "math-display" only; the \`\`\`math fence
			// upgrade is detected via the <pre> parent below.
			let displayMode = classes.includes('math-display');

			let parent: Element | undefined = parents[parents.length - 1];
			let scope: Element = element;

			// ```math fenced block: replace the <pre> and use display mode.
			if (element.tagName === 'code' && languageMath && parent && parent.tagName === 'pre') {
				scope = parent;
				parent = parents[parents.length - 2] as Element | undefined;
				displayMode = true;
			}

			if (!parent) {
				return;
			}

			const source = toText(scope, { whitespace: 'pre' });

			if (!source.trim()) {
				return;
			}

			const index = parent.children.indexOf(scope);

			if (index === -1) {
				return;
			}

			// Fast path: untouched source in the node's natural mode.
			const fast = tryRender(source, displayMode);

			if (fast.html !== null) {
				katexRobustStats.fast += 1;

				if (scope === element) {
					element.children = [{ type: 'raw', value: fast.html } as unknown as ElementContent];
				} else {
					parent.children.splice(index, 1, { type: 'raw', value: fast.html } as unknown as ElementContent);
				}

				return;
			}

			// Recovery ladder — SAME mode, honest degradation.
			let lastError = fast.error;

			for (const candidate of buildCandidates(source, displayMode)) {
				if (candidate === source) {
					continue; // already failed on the fast path
				}

				const result = tryRender(candidate, displayMode);

				if (result.html !== null) {
					katexRobustStats.recovered += 1;

					if (scope === element) {
						element.properties = element.properties ?? {};
						const className = (element.properties.className as string[] | undefined) ?? [];

						element.properties.className = [...className, KATEX_RECOVERED_CLASS];
						element.children = [{ type: 'raw', value: result.html } as unknown as ElementContent];
					} else {
						parent.children.splice(index, 1, {
							type: 'element',
							tagName: 'span',
							properties: { className: [KATEX_RECOVERED_CLASS] },
							children: [{ type: 'raw', value: result.html } as unknown as ElementContent]
						});
					}

					return;
				}

				lastError = result.error;
			}

			// Nothing renders: neutral monospace source, never red.
			katexRobustStats.unrendered += 1;
			parent.children.splice(index, 1, unrenderedSpan(source, lastError));
		});
	};
};
