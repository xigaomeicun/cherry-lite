import { CommandContextMenu, type CommandContextMenuExtraItem } from '@renderer/components/command'
import { ImagePreviewService } from '@renderer/services/ImagePreviewService'
import { getMarkdownSvgSourceKey, isKatexGeneratedSvg, makeSvgSizeAdaptive } from '@renderer/utils/image'
import type { Element as HastElement } from 'hast'
import { Eye } from 'lucide-react'
import { type FC, type SVGProps, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtraProps } from 'streamdown'

interface SvgProps extends SVGProps<SVGSVGElement>, ExtraProps {
  'data-needs-measurement'?: 'true'
  /**
   * While true, skip source-key remount and DOM measurement until defer ends.
   * Chat streaming passes this so incomplete SVGs are not remounted every tick.
   */
  deferSourceRemeasure?: boolean
}

const MarkdownSvgRenderer: FC<SvgProps> = (props) => {
  const { 'data-needs-measurement': needsMeasurement, node, deferSourceRemeasure = false, ...restProps } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const measuredSourceRef = useRef<string | null>(null)
  const { t } = useTranslation()
  const sourceKey = useMemo(
    () => getMarkdownSvgSourceKey(needsMeasurement, node as HastElement | undefined, { defer: deferSourceRemeasure }),
    [needsMeasurement, node, deferSourceRemeasure]
  )
  const isMeasured = Boolean(sourceKey) && measuredSourceRef.current === sourceKey

  useEffect(() => {
    if (!needsMeasurement || !sourceKey || deferSourceRemeasure) return
    if (!svgRef.current || measuredSourceRef.current === sourceKey) return
    makeSvgSizeAdaptive(svgRef.current)
    measuredSourceRef.current = sourceKey
  }, [needsMeasurement, sourceKey, deferSourceRemeasure])

  const onPreview = useCallback(() => {
    if (!svgRef.current) return
    void ImagePreviewService.show(svgRef.current, { format: 'svg' })
  }, [])

  const finalProps = { ...restProps }
  if (isMeasured) {
    delete finalProps.width
    delete finalProps.height
  }

  const items = useMemo<CommandContextMenuExtraItem[]>(
    () => [
      { type: 'item', id: 'svg.preview', label: t('common.preview'), icon: <Eye size="1rem" />, onSelect: onPreview }
    ],
    [onPreview, t]
  )

  const svg = sourceKey ? <svg key={sourceKey} ref={svgRef} {...finalProps} /> : <svg ref={svgRef} {...finalProps} />
  if (isKatexGeneratedSvg(node)) return svg

  return (
    <CommandContextMenu location="webcontents.context" extraItems={items}>
      {svg}
    </CommandContextMenu>
  )
}

export default MarkdownSvgRenderer
