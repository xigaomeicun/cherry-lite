import { CommandContextMenu, type CommandContextMenuExtraItem } from '@renderer/components/command'
import { ImagePreviewService } from '@renderer/services/ImagePreviewService'
import { getMarkdownSvgSourceKey, isKatexGeneratedSvg, makeSvgSizeAdaptive } from '@renderer/utils/image'
import type { Element as HastElement } from 'hast'
import { Eye } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtraProps } from 'streamdown'

interface SvgProps extends React.SVGProps<SVGSVGElement>, ExtraProps {
  'data-needs-measurement'?: 'true'
  /**
   * While true (chat streaming), skip source-key remount and DOM measurement.
   * Measurement runs once when defer ends so incomplete SVGs are not remounted
   * on every stream tick.
   */
  deferSourceRemeasure?: boolean
}

/**
 * A smart SVG renderer for Markdown content.
 *
 * This component handles two types of SVGs passed from Streamdown:
 *
 * 1.  **Pre-processed SVGs**: Simple SVGs that were already handled by the
 *     `rehypeScalableSvg` plugin. These are rendered directly.
 *
 * 2.  **SVGs needing measurement**: Complex SVGs are flagged with
 *     `data-needs-measurement`. This component mutates the mounted element to
 *     make it scalable, and re-runs that measurement whenever the rendered
 *     source changes (after streaming settles). The same source key also
 *     remounts the `<svg>`, so the attributes written by a previous
 *     measurement cannot leak into the next SVG. To prevent React from
 *     reverting these changes during subsequent renders, it stops passing the
 *     original `width` and `height` props after the mutation is complete.
 */
const MarkdownSvgRenderer: FC<SvgProps> = (props) => {
  const { 'data-needs-measurement': needsMeasurement, node, deferSourceRemeasure = false, ...restProps } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const measuredSourceRef = useRef<string | null>(null)
  const { t } = useTranslation()
  const sourceKey = useMemo(
    () =>
      getMarkdownSvgSourceKey(needsMeasurement, node as HastElement | undefined, {
        defer: deferSourceRemeasure
      }),
    [needsMeasurement, node, deferSourceRemeasure]
  )
  const isMeasured = Boolean(sourceKey) && measuredSourceRef.current === sourceKey

  useEffect(() => {
    if (!needsMeasurement || !sourceKey || deferSourceRemeasure) return
    if (!svgRef.current || measuredSourceRef.current === sourceKey) return
    // Directly mutate the DOM element to make it adaptive.
    makeSvgSizeAdaptive(svgRef.current)
    // Remember which source was measured. This does not trigger a re-render.
    measuredSourceRef.current = sourceKey
  }, [needsMeasurement, sourceKey, deferSourceRemeasure])

  const onPreview = useCallback(() => {
    if (!svgRef.current) return
    void ImagePreviewService.show(svgRef.current, { format: 'svg' })
  }, [])

  // Create a mutable copy of props to potentially modify.
  const finalProps = { ...restProps }

  // If the SVG has been measured and mutated, we prevent React from
  // re-applying the original width and height attributes on subsequent renders.
  // This preserves the changes made by `makeSvgSizeAdaptive`.
  if (isMeasured) {
    delete finalProps.width
    delete finalProps.height
  }

  const items = useMemo<CommandContextMenuExtraItem[]>(
    () => [
      { type: 'item', id: 'svg.preview', label: t('common.preview'), icon: <Eye size="1rem" />, onSelect: onPreview }
    ],
    [t, onPreview]
  )

  // Only key when we have a source identity; KaTeX / preprocessed SVGs skip
  // remount thrashing from hast node reference churn during streaming.
  const svg = sourceKey ? <svg key={sourceKey} ref={svgRef} {...finalProps} /> : <svg ref={svgRef} {...finalProps} />
  if (isKatexGeneratedSvg(node)) return svg

  return (
    <CommandContextMenu location="webcontents.context" extraItems={items}>
      {svg}
    </CommandContextMenu>
  )
}

export default MarkdownSvgRenderer
