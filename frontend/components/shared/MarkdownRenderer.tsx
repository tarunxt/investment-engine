import React from 'react';
import ReactMarkdown, { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
    content: string;
    className?: string;
    enableCodeHighlighting?: boolean;
    enableTableStyling?: boolean;
}

type CodeProps = React.ComponentProps<'code'> &
    ExtraProps & {
        inline?: boolean;
        node?: any;
    };

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    content,
    className = '',
    enableCodeHighlighting = true,
    enableTableStyling = true,
}) => {
    if (!content) {
        return null;
    }

    return (
        <article className={`prose prose-sm max-w-none dark:prose-invert ${className}`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    // Headers
                    h1: ({ children, ...props }) => (
                        <h1 className="mb-4 mt-6 text-3xl font-bold text-gray-900 dark:text-gray-100" {...props}>
                            {children}
                        </h1>
                    ),
                    h2: ({ children, ...props }) => (
                        <h2 className="mb-3 mt-5 text-2xl font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-200 dark:border-gray-700 pb-2" {...props}>
                            {children}
                        </h2>
                    ),
                    h3: ({ children, ...props }) => (
                        <h3 className="mb-2 mt-4 text-xl font-semibold text-gray-900 dark:text-gray-100" {...props}>
                            {children}
                        </h3>
                    ),
                    h4: ({ children, ...props }) => (
                        <h4 className="mb-2 mt-3 text-lg font-medium text-gray-900 dark:text-gray-100" {...props}>
                            {children}
                        </h4>
                    ),
                    h5: ({ children, ...props }) => (
                        <h5 className="mb-1 mt-2 text-base font-medium text-gray-900 dark:text-gray-100" {...props}>
                            {children}
                        </h5>
                    ),
                    h6: ({ children, ...props }) => (
                        <h6 className="mb-1 mt-2 text-sm font-medium text-gray-700 dark:text-gray-300" {...props}>
                            {children}
                        </h6>
                    ),

                    // Paragraphs
                    p: ({ children, ...props }) => (
                        <p className="mb-4 leading-7 text-gray-800 dark:text-gray-200" {...props}>
                            {children}
                        </p>
                    ),

                    // Links
                    a: ({ href, children, ...props }) => (
                        <a
                            href={href}
                            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline transition-colors"
                            target={href?.startsWith('http') ? '_blank' : undefined}
                            rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
                            {...props}
                        >
                            {children}
                        </a>
                    ),

                    // Lists
                    ul: ({ children, ...props }) => (
                        <ul className="mb-4 ml-6 list-disc space-y-1 text-gray-800 dark:text-gray-200" {...props}>
                            {children}
                        </ul>
                    ),
                    ol: ({ children, ...props }) => (
                        <ol className="mb-4 ml-6 list-decimal space-y-1 text-gray-800 dark:text-gray-200" {...props}>
                            {children}
                        </ol>
                    ),
                    li: ({ children, ...props }) => (
                        <li className="leading-7" {...props}>
                            {children}
                        </li>
                    ),

                    // Blockquotes
                    blockquote: ({ children, ...props }) => (
                        <blockquote
                            className="mb-4 border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-700 dark:text-gray-300"
                            {...props}
                        >
                            {children}
                        </blockquote>
                    ),

                    // Code blocks with syntax highlighting
                    code({ node, inline, className, children, ...props }: CodeProps) {
                        const match = /language-(\w+)/.exec(className || '');
                        const code = String(children).replace(/\n$/, '');

                        if (!inline && match) {
                            return (
                                <SyntaxHighlighter
                                    style={vscDarkPlus as any}
                                    language={match[1]}
                                    PreTag="div"
                                    className="rounded-lg my-4 text-sm"
                                    showLineNumbers
                                >
                                    {code}
                                </SyntaxHighlighter>
                            );
                        }

                        return inline ? (
                            <code
                                className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-sm font-mono text-red-600 dark:text-red-400"
                                {...props}
                            >
                                {children}
                            </code>
                        ) : (
                            <pre className="my-4 rounded-lg bg-gray-900 p-4 overflow-x-auto">
                                <code
                                    className="text-gray-100 text-sm font-mono"
                                    {...props}
                                >
                                    {children}
                                </code>
                            </pre>
                        );
                    },

                    // Tables
                    table: ({ children }) => (
                        <div className={`my-6 w-full overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 ${enableTableStyling ? '' : 'overflow-x-visible'}`}>
                            <table className="w-full border-collapse text-sm">
                                {children}
                            </table>
                        </div>
                    ),
                    thead: ({ children }) => (
                        <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>
                    ),
                    tbody: ({ children }) => (
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">{children}</tbody>
                    ),
                    tr: ({ children, ...props }) => (
                        <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors" {...props}>
                            {children}
                        </tr>
                    ),
                    th: ({ children, ...props }) => (
                        <th
                            className="border border-gray-200 dark:border-gray-700 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-800"
                            {...props}
                        >
                            {children}
                        </th>
                    ),
                    td: ({ children, ...props }) => (
                        <td
                            className="border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm text-gray-800 dark:text-gray-200"
                            {...props}
                        >
                            {children}
                        </td>
                    ),

                    // Images
                    img: ({ src, alt, ...props }) => (
                        <img
                            src={src}
                            alt={alt}
                            className="my-4 max-w-full rounded-lg shadow-md"
                            loading="lazy"
                            {...props}
                        />
                    ),

                    // Horizontal rule
                    hr: () => (
                        <hr className="my-8 border-t border-gray-200 dark:border-gray-700" />
                    ),

                    // Emphasis
                    strong: ({ children }) => (
                        <strong className="font-semibold text-gray-900 dark:text-gray-100">
                            {children}
                        </strong>
                    ),
                    em: ({ children }) => (
                        <em className="italic text-gray-800 dark:text-gray-200">{children}</em>
                    ),

                    // Inline elements
                    span: ({ children, ...props }) => (
                        <span {...props}>{children}</span>
                    ),
                    div: ({ children, ...props }) => (
                        <div {...props}>{children}</div>
                    ),
                }}
            >
                {content}
            </ReactMarkdown>
        </article>
    );
};

export default MarkdownRenderer;