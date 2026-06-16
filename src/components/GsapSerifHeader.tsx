import React from "react";

interface GsapSerifHeaderProps extends React.HTMLAttributes<HTMLElement> {
  /**
   * The heading text or node elements. Can be a string (supports multi-line split) or an array of lines.
   */
  children?: string | string[];
  lines?: string[];
  className?: string;
  tag?: "h1" | "h2" | "h3" | "h4" | "span" | "div";
  key?: any;
}

export default function GsapSerifHeader({
  children,
  lines: propLines,
  className = "",
  tag: Tag = "h1",
}: GsapSerifHeaderProps) {
  const finalLines: string[] = React.useMemo(() => {
    if (propLines && propLines.length > 0) return propLines;
    if (typeof children === "string") {
      return children.split("\n");
    }
    if (Array.isArray(children)) {
      return children.filter((c) => typeof c === "string") as string[];
    }
    return [];
  }, [children, propLines]);

  return (
    <Tag className={`font-serif tracking-tight text-[var(--text-primary)] ${className}`}>
      {finalLines.map((line, idx) => (
        <span key={idx} className="block overflow-hidden relative align-top">
          <span className="block transform will-change-transform">
            {line}
          </span>
        </span>
      ))}
    </Tag>
  );
}
