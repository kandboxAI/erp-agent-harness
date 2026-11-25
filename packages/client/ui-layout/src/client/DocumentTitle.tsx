/** Keep the browser and desktop window title tied to the configured product. */
import { useEffect } from 'react'

/** Props for the browser title projection. */
export type DocumentTitleProps = {
  /** Build-configured or localized product title. */
  productTitle: string
}

/**
 * Display the product title independently of Session and panel selection.
 * @param props - Build-configured or localized product title.
 * @returns No rendered content.
 */
export function DocumentTitle({ productTitle }: DocumentTitleProps): null {
  useEffect(() => {
    document.title = productTitle
    return () => { document.title = productTitle }
  }, [productTitle])
  return null
}
