import { useId } from 'react';

/*
 * Xora's own artwork: the logo mark and the quiet illustrations of the welcome page and empty states. All of it is
 * decoration (aria-hidden) and takes its colours from the theme through the `xa-*` classes in app.css.
 */

/** An id usable in `url(#…)`, unique per mounted copy. */
function useSvgId(name: string): string {
    return `${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Two angle brackets meeting in an X, with the agent's spark in the corner. */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
    const fill = useSvgId('xora-logo');
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id={fill} x1="2" y1="1" x2="22" y2="23" gradientUnits="userSpaceOnUse">
                    <stop offset="0" className="xa-brand-from" />
                    <stop offset="1" className="xa-brand-to" />
                </linearGradient>
            </defs>
            <rect x="1" y="1" width="22" height="22" rx="7" fill={`url(#${fill})`} />
            <path d="M1.5 8A6.5 6.5 0 0 1 8 1.5h8A6.5 6.5 0 0 1 22.5 8v1.2H1.5z" fill="#fff" opacity="0.1" />
            <path
                d="M7 8.3 10.7 12 7 15.7M17 8.3 13.3 12 17 15.7"
                fill="none"
                stroke="#fff"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="18.6" cy="5.4" r="1.25" fill="#fff" opacity="0.85" />
        </svg>
    );
}

/** A four-pointed spark. */
function Spark({ x, y, r, className }: { x: number; y: number; r: number; className: string }) {
    const k = r * 0.22;
    return (
        <path
            className={className}
            d={`M${x} ${y - r}C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${
                y + r
            }C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z`}
        />
    );
}

/** The welcome page: the app's window with a conversation, a diff, a terminal and an approved change. */
export function WelcomeArt({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 360 220" aria-hidden="true" focusable="false">
            <ellipse className="xa-wash" cx="180" cy="116" rx="156" ry="96" />
            <circle className="xa-dot" cx="324" cy="112" r="2.5" />
            <circle className="xa-dot" cx="38" cy="92" r="2" />
            <circle className="xa-dot-faint" cx="300" cy="200" r="2" />
            <circle className="xa-dot-faint" cx="62" cy="196" r="2.5" />

            {/* The window */}
            <rect className="xa-shadow" x="76" y="42" width="216" height="148" rx="14" />
            <rect className="xa-surface xa-stroke" x="72" y="34" width="216" height="148" rx="14" />
            <path className="xa-subtle" d="M72.5 60H122v121.5H86A13.5 13.5 0 0 1 72.5 168z" />
            <path className="xa-hairline" d="M72.5 60h215M122 60v121.5" />
            <circle className="xa-faint" cx="86" cy="47" r="3" />
            <circle className="xa-faint" cx="96" cy="47" r="3" />
            <circle className="xa-faint" cx="106" cy="47" r="3" />
            <rect className="xa-line" x="80" y="70" width="32" height="5" rx="2.5" />
            <rect className="xa-accent-soft" x="77" y="81" width="41" height="13" rx="4" />
            <rect className="xa-accent xa-half" x="81" y="85.5" width="28" height="4" rx="2" />
            <rect className="xa-line" x="80" y="101" width="26" height="5" rx="2.5" />
            <rect className="xa-line" x="80" y="113" width="30" height="5" rx="2.5" />

            <rect className="xa-bubble" x="198" y="70" width="78" height="18" rx="9" />
            <rect className="xa-accent xa-half" x="208" y="77" width="50" height="4" rx="2" />
            <rect className="xa-line" x="134" y="97" width="112" height="5" rx="2.5" />
            <rect className="xa-line" x="134" y="108" width="134" height="5" rx="2.5" />
            <rect className="xa-line" x="134" y="119" width="84" height="5" rx="2.5" />

            <rect className="xa-subtle xa-stroke" x="134" y="132" width="142" height="38" rx="7" />
            <rect className="xa-del-soft" x="135" y="138" width="140" height="11" />
            <rect className="xa-del" x="140" y="142.5" width="6" height="2" rx="1" />
            <rect className="xa-del xa-half" x="151" y="142" width="62" height="3" rx="1.5" />
            <rect className="xa-add-soft" x="135" y="152" width="140" height="11" />
            <path className="xa-add-stroke" d="M140 157.5h6M143 154.5v6" />
            <rect className="xa-add xa-half" x="151" y="156" width="88" height="3" rx="1.5" />

            {/* A terminal on the left */}
            <g className="xa-float-b">
                <rect className="xa-shadow" x="29" y="126" width="78" height="52" rx="11" />
                <rect className="xa-term" x="26" y="120" width="78" height="52" rx="11" />
                <path className="xa-term-prompt" d="M37.5 134.5l5 4-5 4" />
                <rect className="xa-term-line" x="47" y="137" width="32" height="3.5" rx="1.75" />
                <rect className="xa-term-dim" x="37.5" y="150" width="48" height="3.5" rx="1.75" />
                <rect className="xa-term-dim" x="37.5" y="158" width="28" height="3.5" rx="1.75" />
            </g>

            {/* An approved change on the right */}
            <g className="xa-float-a">
                <rect className="xa-shadow" x="239" y="160" width="100" height="36" rx="11" />
                <rect className="xa-surface xa-stroke" x="236" y="154" width="100" height="36" rx="11" />
                <circle className="xa-ok-soft" cx="254" cy="172" r="9" />
                <path className="xa-ok-stroke" d="M249.8 172.3l3 3 5.6-6" />
                <rect className="xa-faint" x="269" y="165.5" width="52" height="5" rx="2.5" />
                <rect className="xa-line" x="269" y="175.5" width="36" height="4" rx="2" />
            </g>

            <g className="xa-twinkle">
                <Spark x={302} y={40} r={10} className="xa-accent" />
            </g>
            <Spark x={52} y={58} r={5} className="xa-accent-muted" />
        </svg>
    );
}

/** Empty states: a small stack of cards with nothing on them yet. */
export function EmptyArt({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 120 88" aria-hidden="true" focusable="false">
            <ellipse className="xa-wash" cx="60" cy="50" rx="52" ry="34" />
            <rect
                className="xa-subtle xa-stroke"
                x="36"
                y="15"
                width="58"
                height="42"
                rx="8"
                transform="rotate(-7 65 36)"
            />
            <rect className="xa-shadow" x="28" y="30" width="62" height="44" rx="8" />
            <rect className="xa-surface xa-stroke" x="26" y="26" width="62" height="44" rx="8" />
            <circle className="xa-accent-soft" cx="38" cy="38" r="5" />
            <rect className="xa-line" x="47" y="35" width="30" height="5" rx="2.5" />
            <rect className="xa-line" x="34" y="49" width="46" height="4" rx="2" />
            <rect className="xa-line" x="34" y="58" width="30" height="4" rx="2" />
            <Spark x={98} y={22} r={6} className="xa-accent" />
            <circle className="xa-dot" cx="18" cy="34" r="2" />
            <circle className="xa-dot-faint" cx="102" cy="66" r="2" />
        </svg>
    );
}

/** A thread with no messages yet: a waiting agent and a first message. */
export function ConversationArt({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 160 112" aria-hidden="true" focusable="false">
            <ellipse className="xa-wash" cx="80" cy="60" rx="70" ry="44" />
            <rect className="xa-shadow" x="25" y="30" width="80" height="34" rx="12" />
            <rect className="xa-surface xa-stroke" x="22" y="26" width="80" height="34" rx="12" />
            <circle className="xa-faint xa-typing" cx="44" cy="43" r="3.2" />
            <circle className="xa-faint xa-typing" cx="55" cy="43" r="3.2" />
            <circle className="xa-faint xa-typing" cx="66" cy="43" r="3.2" />
            <rect className="xa-bubble" x="62" y="70" width="76" height="26" rx="12" />
            <rect className="xa-accent xa-half" x="74" y="81" width="46" height="4" rx="2" />
            <g className="xa-twinkle">
                <Spark x={128} y={24} r={7} className="xa-accent" />
            </g>
            <circle className="xa-dot" cx="18" cy="78" r="2" />
        </svg>
    );
}
