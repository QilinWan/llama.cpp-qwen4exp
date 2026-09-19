import { visit } from 'unist-util-visit';
import type { Content, Math, Parent, Root } from 'mdast';
import type { Plugin } from 'unified';

/**
 * remark-math only produces a flow (display) "math" node when the "$$"
 * fences sit on their own lines. A model writing a numbered equation as a
 * single line "$$AB = AD <tag>$$" therefore gets a TEXT (inline) math node,
 * and KaTeX then hard-fails on tag-in-inline ("tag works only in display
 * equations") — the whole block echoes as red error source in the UI.
 *
 * This plugin runs right after remark-math (tokenization is done: fenced
 * code, tables and block structure are already resolved by the grammar) and
 * promotes exactly one shape:
 *
 *   a paragraph whose only content is ONE inlineMath node
 *   (surrounded at most by pure-whitespace text nodes),
 *   living directly in root, a listItem, or a blockquote
 *
 * becomes a display "math" node with the same value. Nothing else changes:
 * math mixed with prose stays inline (its correct semantics), math in table
 * cells stays inline (cells cannot contain flow content — the render layer
 * handles those gracefully), and no source text is rewritten, so streaming
 * offsets stay stable and indented-code / fence semantics are untouched.
 *
 * NOTE: remark-math does NOT ship a hast handler function; it renders math
 * by pre-baking "data.hName / hChildren" onto each node (see its enter/exit
 * handlers). A promoted node therefore MUST carry the same data payload as a
 * genuinely-parsed display block ("<pre><code class=language-math
 * math-display>"), or remark-rehype falls back to emitting its raw value as
 * plain text. That data is constructed to match remark-math's own output.
 */
export const remarkMathReclassify: Plugin<[], Root> = () => {
	return (tree: Root) => {
		visit(tree, 'paragraph', (paragraph, index, parent) => {
			if (index === undefined || !parent) {
				return;
			}

			const container = parent as Parent;

			// Only containers that legitimately hold flow content.
			if (container.type !== 'root' && container.type !== 'listItem' && container.type !== 'blockquote') {
				return;
			}

			let mathValue: string | undefined;

			for (const child of paragraph.children) {
				if (child.type === 'inlineMath') {
					if (mathValue !== undefined) {
						return; // more than one math candidate: keep original inline semantics
					}

					mathValue = child.value;
				} else if (child.type === 'text' && child.value.trim() === '') {
					continue; // pure whitespace around the math: fine
				} else {
					return; // real prose mixed with math: genuinely inline
				}
			}

			if (mathValue === undefined || !mathValue.trim()) {
				return;
			}

			const promoted = {
				type: 'math',
				meta: null,
				value: mathValue,
				data: {
					hName: 'pre',
					hChildren: [
						{
							type: 'element',
							tagName: 'code',
							properties: { className: ['language-math', 'math-display'] },
							children: [{ type: 'text', value: mathValue }]
						}
					]
				},
				position: paragraph.position
			} as unknown as Math;

			(container.children as Content[])[index] = promoted;
		});
	};
};
