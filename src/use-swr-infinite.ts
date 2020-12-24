import { useContext, useRef, useState, useEffect, useCallback } from 'react'

import defaultConfig, { cache } from './config'
import SWRConfigContext from './swr-config-context'
import useSWR from './use-swr'

import { keyType, fetcherFn, ConfigInterface, responseInterface } from './types'
type KeyLoader<Data = any> = (
  index: number,
  previousPageData: Data | null
) => keyType
type SWRInfiniteConfigInterface<Data = any, Error = any> = ConfigInterface<
  Data[],
  Error,
  fetcherFn<Data[]>
> & {
  initialSize?: number
  revalidateAll?: boolean
  persistSize?: boolean
}
type SWRInfiniteResponseInterface<Data = any, Error = any> = responseInterface<
  Data[],
  Error
> & {
  size: number
  setSize: (
    size: number | ((size: number) => number)
  ) => Promise<Data[] | undefined>
}

function useSWRInfinite<Data = any, Error = any>(
  getKey: KeyLoader<Data>
): SWRInfiniteResponseInterface<Data, Error>
function useSWRInfinite<Data = any, Error = any>(
  getKey: KeyLoader<Data>,
  config?: SWRInfiniteConfigInterface<Data, Error>
): SWRInfiniteResponseInterface<Data, Error>
function useSWRInfinite<Data = any, Error = any>(
  getKey: KeyLoader<Data>,
  fn?: fetcherFn<Data>,
  config?: SWRInfiniteConfigInterface<Data, Error>
): SWRInfiniteResponseInterface<Data, Error>
function useSWRInfinite<Data = any, Error = any>(
  ...args
): SWRInfiniteResponseInterface<Data, Error> {
  let getKey: KeyLoader<Data>,
    fn: fetcherFn<Data> | undefined,
    config: SWRInfiniteConfigInterface<Data, Error> = {}

  if (args.length >= 1) {
    getKey = args[0]
  }
  if (args.length > 2) {
    fn = args[1]
    config = args[2]
  } else {
    if (typeof args[1] === 'function') {
      fn = args[1]
    } else if (typeof args[1] === 'object') {
      config = args[1]
    }
  }

  config = Object.assign(
    {},
    defaultConfig,
    useContext(SWRConfigContext),
    config
  )
  let {
    initialSize = 1,
    revalidateAll = false,
    persistSize = false,
    fetcher: defaultFetcher,
    ...extraConfig
  } = config

  if (typeof fn === 'undefined') {
    // use the global fetcher
    // we have to convert the type here
    fn = (defaultFetcher as unknown) as fetcherFn<Data>
  }

  // get the serialized key of the first page
  let firstPageKey: string | null = null
  try {
    ;[firstPageKey] = cache.serializeKey(getKey(0, null))
  } catch (err) {
    // not ready
  }

  const rerender = useState<boolean>(false)[1]

  // we use cache to pass extra info (context) to fetcher so it can be globally shared
  // here we get the key of the fetcher context cache
  let contextCacheKey: string | null = null
  if (firstPageKey) {
    contextCacheKey = 'context@' + firstPageKey
  }

  // page count is cached as well, so when navigating the list can be restored
  let pageCountCacheKey: string | null = null
  let cachedPageSize
  if (firstPageKey) {
    pageCountCacheKey = 'size@' + firstPageKey
    cachedPageSize = cache.get(pageCountCacheKey)
  }

  // 拉取多少页的数据
  const pageCountRef = useRef<number>(cachedPageSize || initialSize)
  const didMountRef = useRef<boolean>(false)

  // 当 key 改变时，只拉取前 initialSize 页的数据，可忽略。
  // every time the key changes, we reset the page size if it's not persisted
  useEffect(() => {
    if (didMountRef.current) {
      if (!persistSize) {
        pageCountRef.current = initialSize
      }
    } else {
      didMountRef.current = true
    }
  }, [firstPageKey])

  // actual swr of all pages
  const swr = useSWR<Data[], Error>(
    firstPageKey ? ['many', firstPageKey] : null,
    async () => {
      // get the revalidate context
      const { originalData, force } = cache.get(contextCacheKey) || {}

      // return an array of page data
      const data: Data[] = []

      let previousPageData = null
      for (let i = 0; i < pageCountRef.current; ++i) {
        const [pageKey, pageArgs] = cache.serializeKey(
          getKey(i, previousPageData)
        )

        if (!pageKey) {
          // pageKey is falsy, stop fetching next pages
          break
        }

        // get the current page cache
        let pageData = cache.get(pageKey)

        // (originalData && !config.compare(originalData[i], pageData))
        // 这个比较是指：mutate 中修改了 originalData 且修改后不相等了。
        // 即只重新 fetch 修改的那一页。
        // 修改的时候不要把 data 重新赋值成新的数组，应该直接在原数组上改某一页的数据。
        // 否则 originalData[i] 的值实际上没有变。

        // must revalidate if:
        // - forced to revalidate all
        // - we revalidate the first page by default (e.g.: upon focus)
        // - page has changed
        // - the offset has changed so the cache is missing
        const shouldRevalidatePage =
          revalidateAll ||
          force ||
          (typeof force === 'undefined' && i === 0) ||
          (originalData && !config.compare(originalData[i], pageData)) ||
          typeof pageData === 'undefined'

        if (shouldRevalidatePage) {
          if (pageArgs !== null) {
            pageData = await fn(...pageArgs)
          } else {
            pageData = await fn(pageKey)
          }
          cache.set(pageKey, pageData)
        }

        data.push(pageData)
        previousPageData = pageData
      }

      // once we executed the data fetching based on the context, clear the context
      cache.delete(contextCacheKey)

      // return the data
      return data
    },
    extraConfig
  )

  // keep the data inside a ref
  const dataRef = useRef<Data[]>(swr.data)
  useEffect(() => {
    dataRef.current = swr.data
  }, [swr.data])

  const mutate = useCallback(
    (data, shouldRevalidate = true) => {
      // 只有 shouldRevalidate 时才设置 contextCacheKey
      // 因为这时才会触发 revalidate
      if (shouldRevalidate && typeof data !== 'undefined') {
        // we only revalidate the pages that are changed
        const originalData = dataRef.current
        cache.set(contextCacheKey, { originalData, force: false })
      } else if (shouldRevalidate) {
        // calling `mutate()`, we revalidate all pages
        cache.set(contextCacheKey, { force: true })
      }

      return swr.mutate(data, shouldRevalidate)
    },
    [swr.mutate, contextCacheKey]
  )

  // extend the SWR API
  const size = pageCountRef.current
  const setSize = useCallback(
    arg => {
      if (typeof arg === 'function') {
        pageCountRef.current = arg(pageCountRef.current)
      } else if (typeof arg === 'number') {
        pageCountRef.current = arg
      }
      cache.set(pageCountCacheKey, pageCountRef.current)
      rerender(v => !v)
      return mutate(v => v)
    },
    [mutate, pageCountCacheKey]
  )

  return {
    ...swr,
    mutate,
    size,
    setSize
  } as SWRInfiniteResponseInterface<Data, Error>
}

export {
  useSWRInfinite,
  SWRInfiniteConfigInterface,
  SWRInfiniteResponseInterface
}
