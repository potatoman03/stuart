import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...inputs) => twMerge(clsx(inputs));
export const designTokens = {
    colors: {
        bg: "#F7F7F5",
        surface: "#FFFFFF",
        surfaceAlt: "#F2F2EF",
        ink: "#111111",
        muted: "#737373",
        line: "#E5E5E3",
        lineHard: "#111111",
        accent: "#2962FF",
    },
    shadows: {
        brutal: "2px 2px 0 #E5E5E3",
        brutalLg: "4px 4px 0 #D1D1CE",
        brutalHard: "3px 3px 0 #111111",
    },
};
export const panelClassName = "rounded-[10px] border border-line bg-surface shadow-brutal";
const buttonToneByVariant = {
    primary: "inline-flex items-center justify-center rounded-lg border-2 border-ink bg-ink px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:-translate-x-px hover:-translate-y-px hover:shadow-brutal-hard active:translate-x-0 active:translate-y-0 active:shadow-none disabled:opacity-40 disabled:pointer-events-none",
    secondary: "inline-flex items-center justify-center rounded-lg border-2 border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink transition-all duration-150 hover:border-ink hover:-translate-x-px hover:-translate-y-px hover:shadow-brutal active:translate-x-0 active:translate-y-0 active:shadow-none disabled:opacity-40 disabled:pointer-events-none",
    ghost: "inline-flex items-center justify-center rounded-lg border-2 border-transparent bg-transparent px-4 py-2.5 text-sm font-semibold text-ink transition-all duration-150 hover:bg-surface-alt disabled:opacity-40 disabled:pointer-events-none",
    accent: "inline-flex items-center justify-center rounded-lg border-2 border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:-translate-x-px hover:-translate-y-px hover:shadow-brutal-hard active:translate-x-0 active:translate-y-0 active:shadow-none disabled:opacity-40 disabled:pointer-events-none",
};
export const buttonVariants = (options = "primary") => {
    const tone = typeof options === "string" ? options : (options.tone ?? "primary");
    return buttonToneByVariant[tone];
};
export const artifactToneByKind = {
    mindmap: "bg-blue-50 border-blue-200",
    flashcards: "bg-orange-50 border-orange-200",
    quiz: "bg-emerald-50 border-emerald-200",
    diagram: "bg-violet-50 border-violet-200",
};
//# sourceMappingURL=index.js.map