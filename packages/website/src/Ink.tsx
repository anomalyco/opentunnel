/** The page is printed, not rendered: one static displacement over everything, and grain on top. */
export function Ink() {
  return <>
    <svg width="0" height="0" className="ink-defs" aria-hidden="true">
      <filter id="ink" x="-3%" y="-3%" width="106%" height="106%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.025 0.0325" numOctaves="2" seed="3" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.9" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
    <div className="ink-grain" aria-hidden="true" />
  </>
}

