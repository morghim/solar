import "eventsource"
import DebugLogger from "debug"
import throttle from "lodash.throttle"
import { filter, flatMap, map, merge, multicast, Observable } from "observable-fns"
import PromiseQueue from "p-queue"
import qs from "qs"
import { Asset, Horizon, Networks, Server, ServerApi, Transaction } from "stellar-sdk"
import pkg from "../../../package.json"
import { Cancellation, CustomError } from "~Generic/lib/errors"
import { observableFromAsyncFactory } from "~Generic/lib/observables"
import { parseAssetID } from "~Generic/lib/stellar"
import { max } from "~Generic/lib/strings"
import { createReconnectingSSE } from "../lib/event-source"
import { parseJSONResponse } from "../lib/rest"
import { resetSubscriptions, subscribeToUpdatesAndPoll } from "../lib/subscription"
import { ServiceID } from "./errors"
import {
  accountDataUpdates,
  offerUpdates,
  handleSubmittedTransaction,
  optimisticallyUpdateAccountData,
  optimisticallyUpdateOffers,
  removeStaleOptimisticUpdates,
  OptimisticAccountUpdate,
  OptimisticOfferUpdate
} from "./optimistic-updates/index"

export interface CollectionPage<T> {
  _embedded: {
    records: T[]
  }
  _links: {
    self: {
      href: string
    }
    next: {
      href: string
    }
    prev: {
      href: string
    }
  }
}

interface FeeStatsDetails {
  max: string
  min: string
  mode: string
  p10: string
  p20: string
  p30: string
  p40: string
  p50: string
  p60: string
  p70: string
  p80: string
  p90: string
  p95: string
  p99: string
}

// See <https://www.stellar.org/developers/horizon/reference/endpoints/fee-stats.html>
interface FeeStats {
  last_ledger: string
  last_ledger_base_fee: string
  ledger_capacity_usage: string
  fee_charged: FeeStatsDetails
  max_fee: FeeStatsDetails
}

const accountSubscriptionCache = new Map<string, Observable<Horizon.AccountResponse>>()
const effectsSubscriptionCache = new Map<string, Observable<ServerApi.EffectRecord>>()
const orderbookSubscriptionCache = new Map<string, Observable<ServerApi.OrderbookRecord>>()
const ordersSubscriptionCache = new Map<string, Observable<ServerApi.OfferRecord[]>>()
const transactionsSubscriptionCache = new Map<string, Observable<Horizon.TransactionResponse>>()

const accountDataCache = new Map<string, Horizon.AccountResponse | null>()
const accountDataWaitingCache = new Map<string, ReturnType<typeof waitForAccountDataUncached>>()

// Rate-limit concurrent fetches
const fetchQueuesByHorizon = new Map<string, PromiseQueue>()

const identification = {
  "X-Client-Name": "Solar",
  "X-Client-Version": pkg.version
}

const createAccountCacheKey = (accountID: string, network: Networks) => `${network.toString()}:${accountID}`
// const createAccountCacheKey = (horizonURL: string, accountID: string) => `${horizonURL}:${accountID}`
const createOrderbookCacheKey = (network: Networks, sellingAsset: string, buyingAsset: string) =>
  `${network.toString()}:${sellingAsset}:${buyingAsset}`

const debugHorizonSelection = DebugLogger("net-worker:select-horizon")
const debugSubscriptionReset = DebugLogger("net-worker:reset-subscriptions")

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let roundRobinIndex = 0
async function getRandomURL(network: Networks) {
  const [mainnetURLs, testnetURLs] = await initialHorizonSelection
  const horizonURLs = network === Networks.PUBLIC ? mainnetURLs : testnetURLs
  const url = horizonURLs[roundRobinIndex % horizonURLs.length]
  roundRobinIndex += 1
  return url
}

export function getNetwork(testnet: boolean) {
  return testnet ? Networks.TESTNET : Networks.PUBLIC
}

function getFetchQueue(horizonURL: string): PromiseQueue {
  if (!fetchQueuesByHorizon.has(horizonURL)) {
    const fetchQueue = new PromiseQueue({
      concurrency: 4,
      interval: 1000,
      intervalCap: 4,
      timeout: 10000,
      throwOnTimeout: true
    })
    fetchQueuesByHorizon.set(horizonURL, fetchQueue)
  }

  return fetchQueuesByHorizon.get(horizonURL)!
}

function getServiceID(network: Networks): ServiceID {
  return network === Networks.TESTNET ? ServiceID.HorizonTestnet : ServiceID.HorizonPublic
}

function cachify<T, Args extends any[]>(
  cache: Map<string, Observable<T>>,
  subscribe: (...args: Args) => Observable<T>,
  createCacheKey: (...args: Args) => string
): (...args: Args) => Observable<T> {
  return (...args: Args) => {
    const cacheKey = createCacheKey(...args)
    const cached = cache.get(cacheKey)

    if (cached) {
      return cached
    } else {
      const observable = subscribe(...args)
      cache.set(cacheKey, observable)
      return observable
    }
  }
}

let testnetURLs: string[] = []
let mainnetURLs: string[] = []
let selectionPending = true

const initialHorizonSelection: Promise<[string[], string[]]> = (async () => {
  const pubnetHorizonURLs: string[] = Array.from(
    new Set(
      await Promise.all([
        "https://horizon.stellar.org",
        checkHorizonOrFailover("https://horizon.stellarx.com", "https://horizon.stellar.org"),
        checkHorizonOrFailover("https://horizon.stellar.lobstr.co", "https://horizon.stellar.org")
      ])
    )
  )

  const testnetHorizonURLs: string[] = [
    await checkHorizonOrFailover(
      "https://stellar-horizon-testnet.satoshipay.io/",
      "https://horizon-testnet.stellar.org"
    )
  ]

  return Promise.all([pubnetHorizonURLs, testnetHorizonURLs])
})()

initialHorizonSelection
  .then(result => {
    mainnetURLs = result[0]
    testnetURLs = result[1]
    selectionPending = false
  })
  .catch(console.error)

export function getHorizonURLs(testnet: boolean = false) {
  if (selectionPending) {
    throw initialHorizonSelection
  }
  return testnet ? testnetURLs : mainnetURLs
}

export async function checkHorizonOrFailover(primaryHorizonURL: string, secondaryHorizonURL: string) {
  const debug = debugHorizonSelection
  // Account ID of friendbot (account exists on pubnet, too)
  const testAccountID = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR"

  try {
    // fetch dynamic data to check database access
    const primaryResponse = await Promise.race([
      fetch(new URL(`/accounts/${testAccountID}`, primaryHorizonURL).href),
      delay(2500).then(() => {
        throw Error(`Horizon health check timed out. Trying failover…`)
      })
    ])

    if (primaryResponse.status < 300 || primaryResponse.status === 404) {
      // consider request successful on 404 as well (account might be missing but horizon is working)
      debug(`Primary horizon server seems fine:`, primaryHorizonURL)
      return primaryHorizonURL
    }
  } catch (error) {
    // tslint:disable-next-line no-console
    console.error(error)
  }

  const secondaryResponse = await fetch(new URL(`/accounts/${testAccountID}`, secondaryHorizonURL).href)
  const serverToUse =
    secondaryResponse.status < 300 || secondaryResponse.status === 404 ? secondaryHorizonURL : primaryHorizonURL

  debug(`Primary horizon server check failed. Using ${serverToUse}`)
  return serverToUse
}

export function resetAllSubscriptions() {
  debugSubscriptionReset(`Resetting all active subscriptions…`)

  accountSubscriptionCache.clear()
  effectsSubscriptionCache.clear()
  orderbookSubscriptionCache.clear()
  ordersSubscriptionCache.clear()
  transactionsSubscriptionCache.clear()
  resetSubscriptions()
}

export async function submitTransaction(txEnvelopeXdr: string, network: Networks) {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const url = new URL(`/transactions?${qs.stringify({ tx: txEnvelopeXdr })}`, horizonURL)

  const response = await fetchQueue.add(
    () => {
      return fetch(String(url), {
        method: "POST"
      })
    },
    { priority: 20 }
  )

  if (response.status === 200) {
    handleSubmittedTransaction(horizonURL, new Transaction(txEnvelopeXdr, network))
  }

  return {
    status: response.status,
    data: await response.json()
  }
}

async function waitForAccountDataUncached(accountID: string, network: Networks, shouldCancel?: () => boolean) {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const debug = DebugLogger(`net-worker:wait-for-account:${accountID}`)

  let accountData = null
  let initialFetchFailed = false

  for (let interval = 2500; ; interval = Math.min(interval * 1.05, 5000)) {
    if (shouldCancel && shouldCancel()) {
      debug(`Received signal to cancel waiting for account to be created`)
      throw Cancellation("Stopping to wait for account to become present in network.")
    }

    const url = new URL(`/accounts/${accountID}?${qs.stringify(identification)}`, horizonURL)
    const response = await fetchQueue.add(() => fetch(String(url)))

    if (response.status === 200) {
      accountData = await parseJSONResponse<Horizon.AccountResponse>(response)
      break
    } else if (response.status === 404) {
      initialFetchFailed = true
      await delay(interval)
    } else {
      throw CustomError("RequestFailedError", `Request to ${response.url} failed with status ${response.status}`, {
        target: response.url,
        status: response.status
      })
    }
  }

  debug(`Successfully fetched account meta data. ${initialFetchFailed ? "Had to wait." : ""}`)

  return {
    accountData,
    initialFetchFailed
  }
}

async function waitForAccountData(accountID: string, network: Networks, shouldCancel?: () => boolean) {
  // Cache promise to make sure we don't poll the same account twice simultaneously
  const cacheKey = createAccountCacheKey(accountID, network)
  const pending = accountDataWaitingCache.get(cacheKey)

  if (pending) {
    return pending
  } else {
    const justStarted = waitForAccountDataUncached(accountID, network, shouldCancel)
    accountDataWaitingCache.set(cacheKey, justStarted)
    justStarted.then(
      () => accountDataWaitingCache.delete(cacheKey),
      () => accountDataWaitingCache.delete(cacheKey)
    )
    return justStarted
  }
}

function subscribeToAccountEffectsUncached(accountID: string, network: Networks) {
  let horizonURL = ""
  const fetchQueue = getFetchQueue(horizonURL)
  const debug = DebugLogger(`net-worker:subscriptions:account-effects:${accountID}`)
  const serviceID = getServiceID(network)

  let latestCursor: string | undefined
  let latestEffectCreatedAt: string | undefined

  return subscribeToUpdatesAndPoll<ServerApi.EffectRecord>(
    {
      async applyUpdate(update) {
        debug(`Received new effect:`, update)
        latestCursor = update.paging_token
        latestEffectCreatedAt = update.created_at
        return update
      },
      async fetchUpdate(streamedUpdate) {
        if (streamedUpdate) {
          return streamedUpdate
        } else {
          const effect = await fetchLatestAccountEffect(accountID, network)
          return effect || undefined
        }
      },
      async init() {
        debug(`Subscribing to account effects…`)
        horizonURL = await getRandomURL(network)
        let effect = await fetchLatestAccountEffect(accountID, network)

        if (!effect) {
          debug(`Waiting for account to be created on the network…`)
          await waitForAccountData(accountID, network)
          effect = await fetchLatestAccountEffect(accountID, network)
        }

        latestCursor = effect ? effect.paging_token : latestCursor
        latestEffectCreatedAt = effect ? effect.created_at : latestEffectCreatedAt

        return effect || undefined
      },
      shouldApplyUpdate(update) {
        return (
          !latestEffectCreatedAt || (update.created_at >= latestEffectCreatedAt && update.paging_token !== latestCursor)
        )
      },
      subscribeToUpdates() {
        const createURL = () => {
          const query = {
            ...identification,
            cursor: latestCursor || "now"
          }
          return String(new URL(`/accounts/${accountID}/effects?${qs.stringify(query)}`, horizonURL))
        }

        return multicast(
          observableFromAsyncFactory<ServerApi.EffectRecord>(async observer => {
            return fetchQueue.add(() =>
              createReconnectingSSE(
                createURL,
                {
                  onMessage(message) {
                    const effect: ServerApi.EffectRecord = JSON.parse(message.data)

                    // Don't update latestCursor cursor here – if we do it too early it might cause
                    // shouldApplyUpdate() to return false, since it compares the new effect with itself
                    observer.next(effect)

                    if (effect.type === "account_removed" && effect.account === accountID) {
                      debug(`Closing subscription as account has been merged.`)
                      observer.complete()
                    }
                  },
                  onUnexpectedError(error) {
                    debug(`Unexpected error:`, error)
                    observer.error(error)
                  }
                },
                fetchQueue.add.bind(fetchQueue)
              )
            )
          })
        )
      }
    },
    serviceID,
    {
      retryFetchOnNoUpdate: false
    }
  )
}

export const subscribeToAccountEffects = cachify(
  effectsSubscriptionCache,
  subscribeToAccountEffectsUncached,
  createAccountCacheKey
)

function subscribeToAccountUncached(accountID: string, network: Networks) {
  const debug = DebugLogger(`net-worker:subscriptions:account:${accountID}`)
  let horizonURL = ""
  const serviceID = getServiceID(network)

  let latestSnapshot: string | undefined

  const cacheKey = createAccountCacheKey(accountID, network)
  const createSnapshot = (accountData: Horizon.AccountResponse) =>
    JSON.stringify([accountData.sequence, accountData.balances])

  return subscribeToUpdatesAndPoll<Horizon.AccountResponse | null>(
    {
      async applyUpdate(update) {
        if (update) {
          debug(`Received account meta data update:`, update)
          accountDataCache.set(cacheKey, update)
          latestSnapshot = createSnapshot(update)
        }
        return update
      },
      async fetchUpdate() {
        debug(`Fetching update…`)
        const accountData = await fetchAccountData(accountID, network)
        return accountData || undefined
      },
      async init() {
        debug(`Subscribing to account meta data updates…`)
        const lastKnownAccountData = accountDataCache.get(cacheKey)

        horizonURL = await getRandomURL(network)

        if (lastKnownAccountData) {
          latestSnapshot = createSnapshot(lastKnownAccountData)
          return lastKnownAccountData
        } else {
          const { accountData: initialAccountData } = await waitForAccountData(accountID, network)

          accountDataCache.set(cacheKey, initialAccountData)
          // Don't set `latestSnapshot` yet or the value will initially not be emitted

          return initialAccountData
        }
      },
      shouldApplyUpdate(update) {
        return Boolean(update && (!latestSnapshot || createSnapshot(update) !== latestSnapshot))
      },
      subscribeToUpdates() {
        const handleNewOptimisticUpdate = (newOptimisticUpdate: OptimisticAccountUpdate) => {
          const accountData = accountDataCache.get(cacheKey)

          if (newOptimisticUpdate.effectsAccountID === accountID && newOptimisticUpdate.horizonURL === horizonURL) {
            return accountData ? optimisticallyUpdateAccountData(horizonURL, accountData) : accountData
          } else {
            return accountData
          }
        }
        return merge(
          // Update whenever we receive an account effect push notification
          subscribeToAccountEffects(accountID, network).pipe(map(() => fetchAccountData(accountID, network))),
          // Update on new optimistic updates
          accountDataUpdates.observe().pipe(
            map(handleNewOptimisticUpdate),
            filter(accountData => Boolean(accountData))
          ),
          // Initially fetch data with a delay to make sure we don't miss anything
          Observable.from([0]).pipe(
            map(async () => {
              await delay(1000)
              return fetchAccountData(accountID, network)
            })
          )
        )
      }
    },
    serviceID
  )
}

export const subscribeToAccount = cachify(accountSubscriptionCache, subscribeToAccountUncached, createAccountCacheKey)

function subscribeToAccountTransactionsUncached(accountID: string, network: Networks) {
  const debug = DebugLogger(`net-worker:subscriptions:account-transactions:${accountID}`)

  let latestCursor: string | undefined

  const fetchInitial = async () => {
    const page = await fetchAccountTransactions(accountID, network, {
      limit: 1,
      order: "desc"
    })
    const latestTxs = page._embedded.records

    if (latestTxs.length > 0) {
      latestCursor = latestTxs[0].paging_token
    }
  }

  const fetchLatestTxs = throttle(
    async () => {
      debug(`Fetching latest transactions…`)

      if (latestCursor) {
        const page = await fetchAccountTransactions(accountID, network, { cursor: latestCursor, limit: 10 })
        return [page, "asc"] as const
      } else {
        const page = await fetchAccountTransactions(accountID, network, { limit: 10, order: "desc" })
        return [page, "desc"] as const
      }
    },
    200,
    { leading: true, trailing: true }
  )

  debug(`Subscribing to account's transactions…`)

  fetchInitial().catch(error => {
    // tslint:disable-next-line no-console
    console.error(error)
  })

  return multicast(
    subscribeToAccountEffects(accountID, network).pipe(
      flatMap(async function*(): AsyncIterableIterator<Horizon.TransactionResponse> {
        for (let i = 0; i < 3; i++) {
          const [page, order] = await fetchLatestTxs()
          const newTxs = order === "asc" ? page._embedded.records : page._embedded.records.reverse()

          yield* newTxs

          if (newTxs.length > 0) {
            debug(`Received new transactions:`, newTxs)

            const latestTx = newTxs[newTxs.length - 1]
            latestCursor = latestTx.paging_token
          }

          // There might be race conditions between the different horizon endpoints
          // Wait 350ms, then fetch again, in case the previous fetch didn't return the latest txs yet
          await delay(350)
        }
      })
    )
  )
}

export const subscribeToAccountTransactions = cachify(
  transactionsSubscriptionCache,
  subscribeToAccountTransactionsUncached,
  createAccountCacheKey
)

function subscribeToOpenOrdersUncached(accountID: string, network: Networks) {
  const debug = DebugLogger(`net-worker:subscriptions:account-orders:${accountID}`)
  let horizonURL = ""
  const serviceID = getServiceID(network)

  let latestCursor: string | undefined
  let latestSet: ServerApi.OfferRecord[] = []

  const fetchUpdate = async () => {
    debug(`Fetching account's open orders…`)

    // Don't use latest cursor as we want to fetch all open orders
    // (otherwise we could not handle order deletions)
    const page = await fetchAccountOpenOrders(accountID, network, { order: "desc" })
    return page._embedded.records
  }

  return subscribeToUpdatesAndPoll<ServerApi.OfferRecord[]>(
    {
      async applyUpdate(update) {
        debug(`Received updated open orders:`, update)

        if (update.length > 0) {
          const latestID = max(
            update.map(offer => String(offer.id)),
            "0"
          )
          latestCursor = update.find(offer => String(offer.id) === latestID)!.paging_token
        }

        latestSet = update
        return update
      },
      fetchUpdate,
      async init() {
        debug(`Subscribing to open orders…`)
        horizonURL = await getRandomURL(network)
        const records = await fetchUpdate()

        if (records.length > 0) {
          latestCursor = records[0].paging_token
        }

        latestSet = records
        return records
      },
      shouldApplyUpdate(update) {
        const latestUpdateCursor = max(
          update.map(record => record.paging_token),
          "0"
        )
        const emptySet = update.length === 0
        const latestSetEmpty = latestSet.length === 0
        return emptySet !== latestSetEmpty || (!emptySet && latestUpdateCursor !== latestCursor)
      },
      subscribeToUpdates() {
        const handleNewOptimisticUpdate = (newOptimisticUpdate: OptimisticOfferUpdate) => {
          if (newOptimisticUpdate.effectsAccountID === accountID && newOptimisticUpdate.horizonURL === horizonURL) {
            return optimisticallyUpdateOffers(horizonURL, accountID, latestSet)
          } else {
            return latestSet
          }
        }
        // We somewhat rely on the optimistic updates as a trigger to fetch
        // actual on-ledger data as the open orders SSE stream turns out to be
        // unreliable and the account effects stream only indicates a trade
        // happening, not the creation/cancellation of one
        return merge(
          subscribeToAccountEffects(accountID, network).pipe(map(() => fetchUpdate())),
          offerUpdates.observe().pipe(map(handleNewOptimisticUpdate))
        )
      }
    },
    serviceID
  )
}

export const subscribeToOpenOrders = cachify(
  ordersSubscriptionCache,
  subscribeToOpenOrdersUncached,
  createAccountCacheKey
)

function createOrderbookQuery(selling: Asset, buying: Asset) {
  const query: any = { limit: 100 }

  query.buying_asset_type = buying.getAssetType()
  query.selling_asset_type = selling.getAssetType()

  if (!buying.isNative()) {
    query.buying_asset_code = buying.getCode()
    query.buying_asset_issuer = buying.getIssuer()
  }
  if (!selling.isNative()) {
    query.selling_asset_code = selling.getCode()
    query.selling_asset_issuer = selling.getIssuer()
  }

  return query
}

function createEmptyOrderbookRecord(base: Asset, counter: Asset): ServerApi.OrderbookRecord {
  return {
    _links: {
      self: {
        href: ""
      }
    },
    asks: [],
    bids: [],
    base,
    counter
  }
}

function subscribeToOrderbookUncached(network: Networks, sellingAsset: string, buyingAsset: string) {
  const debug = DebugLogger(`net-worker:subscriptions:orderbook:${buyingAsset}-${sellingAsset}`)

  const buying = parseAssetID(buyingAsset)
  const selling = parseAssetID(sellingAsset)
  const query = createOrderbookQuery(selling, buying)

  if (selling.equals(buying)) {
    return Observable.from<ServerApi.OrderbookRecord>([createEmptyOrderbookRecord(buying, buying)])
  }

  let horizonURL = ""
  const createURL = () => String(new URL(`/order_book?${qs.stringify({ ...query, cursor: "now" })}`, horizonURL))
  const fetchUpdate = () => fetchOrderbookRecord(network, sellingAsset, buyingAsset)

  let latestKnownSnapshot = ""
  const fetchQueue = getFetchQueue(horizonURL)
  const serviceID = getServiceID(network)

  // TODO: Optimize - Make UpdateT = ValueT & { [$snapshot]: string }

  return subscribeToUpdatesAndPoll(
    {
      async applyUpdate(update) {
        debug(`Received order book update:`, update)
        latestKnownSnapshot = JSON.stringify(update)
        return update
      },
      fetchUpdate,
      async init() {
        debug(`Subscribing to order book…`)
        horizonURL = await getRandomURL(network)
        const record = await fetchUpdate()
        latestKnownSnapshot = JSON.stringify(record)
        return record
      },
      shouldApplyUpdate(update) {
        const snapshot = JSON.stringify(update)
        return snapshot !== latestKnownSnapshot
      },
      subscribeToUpdates() {
        return observableFromAsyncFactory<ServerApi.OrderbookRecord>(observer => {
          return fetchQueue.add(() =>
            createReconnectingSSE(
              createURL,
              {
                onMessage(message) {
                  const record: ServerApi.OrderbookRecord = JSON.parse(message.data)
                  observer.next(record)
                },
                onUnexpectedError(error) {
                  debug(`Unexpected error:`, error)
                  observer.error(error)
                }
              },
              fetchQueue.add.bind(fetchQueue)
            )
          )
        })
      }
    },
    serviceID
  )
}

export const subscribeToOrderbook = cachify(
  orderbookSubscriptionCache,
  subscribeToOrderbookUncached,
  createOrderbookCacheKey
)

export interface PaginationOptions {
  cursor?: string
  limit?: number
  order?: "asc" | "desc"
}

export async function fetchAccountData(
  accountID: string,
  network: Networks,
  priority: number = 2
): Promise<(Horizon.AccountResponse & { home_domain?: string | undefined }) | null> {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const url = new URL(`/accounts/${accountID}?${qs.stringify(identification)}`, horizonURL)
  const response = await fetchQueue.add(() => fetch(String(url)), { priority })

  if (response.status === 404) {
    return null
  }

  const accountData = await parseJSONResponse<Horizon.AccountResponse & { home_domain: string | undefined }>(response)
  return optimisticallyUpdateAccountData(horizonURL, accountData)
}

export async function fetchLatestAccountEffect(accountID: string, network: Networks) {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const url = new URL(
    `/accounts/${accountID}/effects?${qs.stringify({
      ...identification,
      limit: 1,
      order: "desc"
    })}`,
    horizonURL
  )

  const response = await fetchQueue.add(() => fetch(String(url)), { priority: 2 })

  if (response.status === 404) {
    return null
  }

  return parseJSONResponse<ServerApi.EffectRecord>(response)
}

export interface FetchTransactionsOptions extends PaginationOptions {
  emptyOn404?: boolean
}

export async function fetchAccountTransactions(
  accountID: string,
  network: Networks,
  options: FetchTransactionsOptions = {}
): Promise<CollectionPage<Horizon.TransactionResponse>> {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const pagination = {
    cursor: options.cursor,
    limit: options.limit,
    order: options.order
  }
  const url = new URL(
    `/accounts/${accountID}/transactions?${qs.stringify({ ...identification, ...pagination })}`,
    horizonURL
  )
  const response = await fetchQueue.add(() => fetch(String(url)), { priority: 1 })

  if (response.status === 404 && options.emptyOn404) {
    return {
      _links: {
        next: { href: String(url) },
        prev: { href: String(url) },
        self: { href: String(url) }
      },
      _embedded: {
        records: []
      }
    }
  }

  const collection = await parseJSONResponse<CollectionPage<Horizon.TransactionResponse>>(response)

  removeStaleOptimisticUpdates(
    horizonURL,
    collection._embedded.records.map(record => record.hash)
  )
  return collection
}

export async function fetchAccountOpenOrders(accountID: string, network: Networks, options: PaginationOptions = {}) {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const url = new URL(`/accounts/${accountID}/offers?${qs.stringify({ ...identification, ...options })}`, horizonURL)

  const response = await fetchQueue.add(() => fetch(String(url)), { priority: 1 })

  return parseJSONResponse<CollectionPage<ServerApi.OfferRecord>>(response)
}

export async function fetchFeeStats(horizonURL: string): Promise<FeeStats> {
  const fetchQueue = getFetchQueue(horizonURL)
  const url = new URL("/fee_stats", horizonURL)

  const response = await fetchQueue.add(() => fetch(url.toString()), {
    priority: 10
  })

  if (!response.ok) {
    throw CustomError("RequestFailedError", `Request to ${url} failed with status code ${response.status}`, {
      target: url.toString(),
      status: response.status
    })
  }
  return response.json()
}

export async function fetchOrderbookRecord(network: Networks, sellingAsset: string, buyingAsset: string) {
  if (buyingAsset === sellingAsset) {
    return createEmptyOrderbookRecord(parseAssetID(buyingAsset), parseAssetID(buyingAsset))
  }
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const query = createOrderbookQuery(parseAssetID(sellingAsset), parseAssetID(buyingAsset))
  const url = new URL(`/order_book?${qs.stringify({ ...identification, ...query })}`, horizonURL)

  const response = await fetchQueue.add(() => fetch(String(url)), { priority: 1 })
  return parseJSONResponse<ServerApi.OrderbookRecord>(response)
}

export async function fetchTimebounds(timeout: number, network: Networks) {
  const horizonURL = await getRandomURL(network)
  const fetchQueue = getFetchQueue(horizonURL)
  const horizon = new Server(horizonURL)

  return fetchQueue.add(() => horizon.fetchTimebounds(timeout), {
    priority: 10
  })
}
