import { Pica } from './sdk'
import {
    log,
    mark,
    loadEnv,
    filterEpisodes,
    filterPictures,
    isValidComicId,
    selectChapterByInput
} from './utils'
import ora from 'ora'
import Input from '@inquirer/input'
import Password from '@inquirer/password'
import Select from '@inquirer/select'
import Checkbox from '@inquirer/checkbox'
import ProgressBar from 'progress'
import { Comic } from './types'
import pLimit from 'p-limit'
import pico from 'picocolors'
import Table from 'cli-table3'

loadEnv()

const keysTip = [
    `${pico.cyan('<space>')} 选中`,
    `${pico.cyan('<a>')} 全选`,
    `${pico.cyan('<i>')} 反选`,
    `${pico.cyan('<enter>')} 确认`
]
const checkboxHelpTip = ` (${keysTip.join(', ')})`

/**
 * 生肉标记：只用在「分区 + 标签」上，不再看标题，也不再用 chineseTeam 空值推断。
 *
 * 历史教训（2026-11-10）：
 * 1. 原来有 'raw' 和 'untranslated'，而命中方式是纯子串 includes，
 *    于是 draw / strawberry / withdrawal 这类词全被误判成生肉 —— 已删。
 * 2. 原来 chineseTeam 为空就判生肉，但 Cosplay / 写真 / CG 集这类内容
 *    本来就没有汉化组，导致整类被吃掉 —— 改成显式分区标签判定，
 *    严格的 chineseTeam 推断挪到可选的 PICA_DL_RAW_STRICT。
 */
const RAW_MARKERS = ['生肉', '日文', '日本語', '日語', '无汉化', '無汉化']

/**
 * 繁简归一：哔咔的分区名是繁体（偽娘哲學/CG雜圖/扶他樂園/耽美花園），
 * 而用户写的是简体，直接 substring 会全部匹配不上。
 */
const T2S: Record<string, string> = {
    偽: '伪', 學: '学', 雜: '杂', 圖: '图', 樂: '乐', 園: '园', 長: '长',
    單: '单', 強: '强', 類: '类', 東: '东', 艦: '舰', 隊: '队', 語: '语',
    漢: '汉', 譯: '译', 圓: '圆', 藍: '蓝', 純: '纯', 愛: '爱', 後: '后',
    宮: '宫', 閃: '闪', 轉: '转', 換: '换', 戀: '恋', 帶: '带', 歐: '欧',
    書: '书', 錄: '录', 濕: '湿', 薦: '荐', 禮: '礼', 電: '电', 們: '们',
    嗶: '哔', 動: '动', 話: '话', 頭: '头', 髮: '发', 體: '体', 雙: '双',
    從: '从', 來: '来', 個: '个', 麼: '么', 這: '这', 那: '那', 與: '与'
}

function norm(text: string): string {
    let out = ''
    for (const ch of text.toLowerCase()) {
        out += T2S[ch] ?? ch
    }
    return out
}

function hitsAny(text: string, terms: string[]): boolean {
    const hay = norm(text)
    return terms.some((t) => hay.includes(norm(t)))
}

function parseRecentHours(): number | null {
    const raw = process.env.PICA_DL_RECENT_HOURS?.trim()
    if (!raw) return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return n
}

function parseList(name: string): string[] {
    const raw = process.env[name]?.trim()
    if (!raw) return []
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
}

function parseLimit(): number {
    const raw = process.env.PICA_DL_LIMIT?.trim()
    if (!raw) return 0
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.floor(n)
}

function parseBlock(): string {
    return process.env.PICA_DL_BLOCK?.trim() || ''
}

/**
 * 标题层筛选：用户在网页里填的关键词，命中标题就排除 / 保留。
 * 和分区排除分开，因为分区名是固定的，标题是自由的。
 */
function hitTitle(comic: Comic, terms: string[]): boolean {
    if (terms.length === 0) return false
    return hitsAny(comic.title || '', terms)
}

/** 只下指定的 id（网页预览后勾选的那几本）。空 = 不限制。 */
function parsePickIds(): Set<string> {
    const raw = process.env.PICA_DL_PICK_IDS?.trim()
    if (!raw) return new Set()
    return new Set(
        raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    )
}

function isWithinHours(updatedAt: string, hours: number): boolean {
    const t = Date.parse(updatedAt)
    if (!Number.isFinite(t)) return false
    return Date.now() - t <= hours * 3600 * 1000
}

/**
 * 用于「排除分区」的字段：只看 categories + tags，不看 title。
 * 标题里出现「女性向」「生肉」这类词不等于它属于那个分区，
 * 拿标题做排除会误杀标题恰好含这些词的正常作品。
 */
function comicTags(comic: Comic): string {
    return [...(comic.categories || []), ...(comic.tags || [])].join('|')
}

/** 完整字段（含标题）：只在「生肉标记」这类宽匹配上用 */
function comicFields(comic: Comic): string {
    return `${comicTags(comic)}|${comic.title || ''}`
}

function hitExclude(comic: Comic, exclude: string[]): boolean {
    if (exclude.length === 0) return false
    return hitsAny(comicTags(comic), exclude)
}

/** 只保留命中指定分类的漫画（空数组=不限制） */
function hitInclude(comic: Comic, include: string[]): boolean {
    if (include.length === 0) return true
    return hitsAny(comicTags(comic), include)
}

function parseFlag(name: string): boolean {
    const raw = process.env[name]?.trim().toLowerCase()
    if (!raw) return false
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/**
 * 生肉判定。
 * 默认宽松：只看 categories/tags/标题里有没有明确的中/日文「生肉」标记。
 * PICA_DL_RAW_STRICT=true 时额外把「chineseTeam 为空」也算生肉
 * （会误杀 Cosplay / 写真 / CG 集，默认关闭）。
 */
function isRaw(comic: Comic, strict = false): boolean {
    if (hitsAny(comicFields(comic), RAW_MARKERS)) return true
    if (strict) {
        const team = (comic.chineseTeam || '').trim()
        if (!team) return true
    }
    return false
}

/**
 * 被过滤掉的条目。只在 PICA_DL_DEBUG_DROPS=true 时打印，
 * 用来回答「到底谁被过滤了、因为什么」。
 */
type Drop = { title: string; reason: string; tags: string }

/**
 * 全站最新：空 block 的 comics?s=dd 不返回更新流（实测只有 1 条且是旧书），
 * 所以改为遍历所有分区，按更新时间倒序翻页，去重后合并。
 *
 * 翻页页数按时间窗估算：一页约 20 本，大分区一天能出好几页。
 * 只看第一页的话，120 小时窗口会漏掉容量大的分区里的旧一半。
 */
function pagesForHours(hours: number | null): number {
    if (hours === null) return 3
    if (hours <= 24) return 1
    if (hours <= 72) return 3
    if (hours <= 168) return 5
    return 8
}
async function searchAllBlocks(
    pica: Pica,
    hours: number | null,
    exclude: string[],
    include: string[],
    dropRaw: boolean,
    limit: number,
    strictRaw = false,
    drops: Drop[] = []
): Promise<{ kept: Comic[]; droppedRaw: number; droppedCat: number; scanned: number; stale: number }> {
    const kept: Comic[] = []
    const seen = new Set<string>()
    let droppedRaw = 0
    let droppedCat = 0
    let scanned = 0
    let stale = 0

    const cats: any = await pica.categories()
    const titles: string[] = (cats?.categories || [])
        .map((c: any) => String(c?.title || '').trim())
        .filter(Boolean)
    const maxPages = pagesForHours(hours)

    for (const title of titles) {
        let stopBlock = false
        for (let page = 1; page <= maxPages && !stopBlock; page++) {
            let docs: Comic[] = []
            try {
                const res: any = await pica.comics(title, '', pica.Order.latest, page)
                const pg = res?.comics ?? res
                docs = pg?.docs || []
            } catch {
                break
            }
            if (docs.length === 0) break

            for (const c of docs) {
                if (seen.has(c._id)) continue
                seen.add(c._id)
                scanned++

                // 分区列表接口不返回 updated_at / chineseTeam，逐条补详情
                let stampFound = false
                if (!c.updated_at) {
                    try {
                        const info = await pica.comicInfo(c._id)
                        if (info?.updated_at) {
                            c.updated_at = info.updated_at
                            stampFound = true
                        }
                        if (!c.chineseTeam && info?.chineseTeam) c.chineseTeam = info.chineseTeam
                        if (info?.tags) c.tags = info.tags
                        if (info?.categories) c.categories = info.categories
                    } catch {
                        // 查不到就放行
                    }
                } else {
                    stampFound = true
                }

                if (hours !== null && stampFound && c.updated_at && !isWithinHours(c.updated_at, hours)) {
                    stale++
                    stopBlock = true // 分区内已按时间倒序，遇到旧书就换下一个分区
                    break
                }
                if (hitExclude(c, exclude)) {
                    droppedCat++
                    drops.push({ title: c.title, reason: `分区/标签命中 ${exclude.join(',')}`, tags: comicTags(c) })
                    continue
                }
                if (dropRaw && isRaw(c, strictRaw)) {
                    droppedRaw++
                    drops.push({
                        title: c.title,
                        reason: strictRaw ? '生肉（严格：含无汉化组）' : '生肉标记',
                        tags: comicTags(c)
                    })
                    continue
                }
                if (!hitInclude(c, include)) {
                    drops.push({ title: c.title, reason: `未命中分类 ${include.join(',')}`, tags: comicTags(c) })
                    continue
                }
                kept.push(c)
            }
        }
    }

    kept.sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''))
    const capped = limit > 0 ? kept.slice(0, limit) : kept
    return { kept: capped, droppedRaw, droppedCat, scanned, stale }
}

/**
 * 按分区（block）浏览：comics?c=<block>&s=dd&page=N
 * 同样支持时间窗 / 排除 / 生肉 / 数量上限
 */
async function searchBlock(
    pica: Pica,
    block: string,
    hours: number | null,
    exclude: string[],
    include: string[],
    dropRaw: boolean,
    limit: number,
    strictRaw = false,
    drops: Drop[] = []
): Promise<{ kept: Comic[]; droppedRaw: number; droppedCat: number; scanned: number; stale: number }> {
    const kept: Comic[] = []
    let droppedRaw = 0
    let droppedCat = 0
    let scanned = 0
    let stale = 0
    const maxPage = 80
    outer: for (let page = 1; page <= maxPage; page++) {
        const res: any = await pica.comics(block, '', pica.Order.latest, page)
        const pg = res?.comics ?? res
        const docs: Comic[] = pg?.docs || []
        if (docs.length === 0) break

        for (const c of docs) {
            scanned++
            // 分区列表接口不返回 updated_at，需要单独查详情
            if (!c.updated_at) {
                try {
                    const info = await pica.comicInfo(c._id)
                    if (info?.updated_at) c.updated_at = info.updated_at
                    if (!c.chineseTeam && info?.chineseTeam) c.chineseTeam = info.chineseTeam
                    if (info?.tags) c.tags = info.tags
                    if (info?.categories) c.categories = info.categories
                } catch {
                    // 查不到就放行，避免整批漏掉
                }
            }
            if (hours !== null && c.updated_at && !isWithinHours(c.updated_at, hours)) {
                // s=dd 已按时间倒序，遇到超窗的可以直接停
                stale++
                break outer
            }
            if (hitExclude(c, exclude)) {
                droppedCat++
                drops.push({ title: c.title, reason: `分区/标签命中 ${exclude.join(',')}`, tags: comicTags(c) })
                continue
            }
            if (dropRaw && isRaw(c, strictRaw)) {
                droppedRaw++
                drops.push({
                    title: c.title,
                    reason: strictRaw ? '生肉（严格：含无汉化组）' : '生肉标记',
                    tags: comicTags(c)
                })
                continue
            }
            if (!hitInclude(c, include)) {
                drops.push({ title: c.title, reason: `未命中分类 ${include.join(',')}`, tags: comicTags(c) })
                continue
            }
            kept.push(c)
            if (limit > 0 && kept.length >= limit) break outer
        }

        const pages = pg?.pages ?? 1
        if (page >= pages) break
    }
    return { kept, droppedRaw, droppedCat, scanned, stale }
}

/**
 * 按更新时间倒序搜索：可同时受「时间窗」和「数量」限制
 * hours 为 null 时不做时间过滤；limit > 0 时凑够就停
 */
async function searchRecent(
    pica: Pica,
    keyword: string,
    hours: number | null,
    exclude: string[],
    include: string[],
    dropRaw: boolean,
    limit: number,
    strictRaw = false,
    drops: Drop[] = []
): Promise<{ kept: Comic[]; droppedRaw: number; droppedCat: number; scanned: number }> {
    const kept: Comic[] = []
    let droppedRaw = 0
    let droppedCat = 0
    let scanned = 0
    const maxPage = 30
    for (let page = 1; page <= maxPage; page++) {
        const res = await pica.search(keyword, page, pica.Order.latest)
        if (!res.docs || res.docs.length === 0) break
        let freshOnPage = 0
        for (const c of res.docs) {
            if (hours !== null && !isWithinHours(c.updated_at, hours)) continue
            freshOnPage++
            scanned++
            if (hitExclude(c, exclude)) {
                droppedCat++
                drops.push({ title: c.title, reason: `分区/标签命中 ${exclude.join(',')}`, tags: comicTags(c) })
                continue
            }
            if (dropRaw && isRaw(c, strictRaw)) {
                droppedRaw++
                drops.push({
                    title: c.title,
                    reason: strictRaw ? '生肉（严格：含无汉化组）' : '生肉标记',
                    tags: comicTags(c)
                })
                continue
            }
            if (!hitInclude(c, include)) {
                drops.push({ title: c.title, reason: `未命中分类 ${include.join(',')}`, tags: comicTags(c) })
                continue
            }
            kept.push(c)
        }
        if (hours !== null && freshOnPage === 0) break
        if (hours !== null && freshOnPage < res.docs.length) break
        if (limit > 0 && kept.length >= limit) break
        if (page >= res.pages) break
    }
    return { kept, droppedRaw, droppedCat, scanned }
}

/**
 * 带重试的异步调用。
 * pica-cli 自带的 axios 拦截器重试只覆盖「请求阶段」，
 * 像 read ECONNRESET 这种在响应体读取阶段才炸的错误会被直接 reject，
 * 一个图片挂掉就让整轮 exit 1、连 artifact 都产不出来。
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    retries = 3,
    baseDelay = 1500
): Promise<T> {
    let lastErr: unknown
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            if (i === retries) break
            const wait = baseDelay * (i + 1)
            log.warn(
                `${label} 第${i + 1}次失败（${(err as Error)?.message || err}），${wait}ms 后重试`
            )
            await new Promise((r) => setTimeout(r, wait))
        }
    }
    throw lastErr
}

async function main() {
    const {
        PICA_ACCOUNT,
        PICA_PASSWORD,
        PICA_DL_CONTENT,
        PICA_DL_CHAPTER,
        PICA_DL_FAV_PAGE,
        PICA_DL_CONCURRENCY,
        PICA_PRINT_FAVS,
        PICA_IN_GITHUB
    } = process.env
    const PICA_DL_SEARCH_KEYWORDS = process.env.PICA_DL_SEARCH_KEYWORDS?.trim()

    const recentHours = parseRecentHours()
    const excludeCategories = parseList('PICA_DL_EXCLUDE_CATEGORIES')
    const includeCategories = parseList('PICA_DL_INCLUDE_CATEGORIES')
    const limit = parseLimit()
    const block = parseBlock()
    const dropRaw = process.env.PICA_DL_DROP_RAW !== 'false'
    const strictRaw = parseFlag('PICA_DL_RAW_STRICT')
    const debugDrops = parseFlag('PICA_DL_DEBUG_DROPS')
    const titleExclude = parseList('PICA_DL_TITLE_EXCLUDE')
    const titleInclude = parseList('PICA_DL_TITLE_INCLUDE')
    const pickIds = parsePickIds()
    const dryRun = parseFlag('PICA_DL_DRY_RUN')
    const drops: Drop[] = []

    const account =
        PICA_ACCOUNT ||
        (await Input({
            message: '请输入账户名称',
            transformer: (val) => val.trim()
        }))
    const password =
        PICA_PASSWORD ||
        (await Password({
            message: '请输入账户密码',
            mask: true
        }))

    const spinner = ora('正在登录哔咔').start()
    const pica = new Pica()
    await pica.login(account, password)
    spinner.stop()

    if (recentHours !== null) {
        log.info(`时间过滤：仅保留 ${pico.cyan(recentHours + ' 小时')}内更新的漫画`)
    }
    if (excludeCategories.length > 0) {
        log.info(`分区排除：${pico.cyan(excludeCategories.join(', '))}`)
    }
    if (dropRaw) {
        log.info(`生肉过滤：${pico.cyan('已开启')}`)
    }
    if (includeCategories.length > 0) {
        log.info(`分类限定：${pico.cyan(includeCategories.join(', '))}`)
    }
    if (titleExclude.length > 0) {
        log.info(`标题排除：${pico.cyan(titleExclude.join(', '))}`)
    }
    if (titleInclude.length > 0) {
        log.info(`标题限定：${pico.cyan(titleInclude.join(', '))}`)
    }
    if (pickIds.size > 0) {
        log.info(`指定清单：${pico.cyan(pickIds.size + ' 部')}（只下这几本）`)
    }
    if (dryRun) {
        log.info(`干跑：${pico.cyan('只列清单，不下载')}`)
    }
    if (limit > 0) {
        log.info(`数量上限：${pico.cyan(limit + ' 部')}（过滤后按更新时间取最新的）`)
    }
    if (block) {
        log.info(`分区浏览：${pico.cyan(block)}（按更新时间倒序）`)
    }

    const answer =
        PICA_DL_CONTENT ||
        (await Select({
            message: '想下载哪些漫画？',
            choices: [
                { name: '去搜索', value: 'search' },
                { name: '最新更新（全站/分区）', value: 'recent' },
                { name: '收藏夹', value: 'favorites' },
                { name: '排行榜', value: 'leaderboard' }
            ]
        }))

    const comics: Comic[] = []
    if (answer === 'leaderboard') {
        const res = await pica.leaderboard()
        comics.push(...res)
    }

    if (answer === 'favorites') {
        spinner.start('正在获取收藏夹信息')
        const res = await pica.favoritesAll(PICA_DL_FAV_PAGE)
        comics.push(...res.comics)
        spinner.stop()

        log.info(
            `收藏夹共有 ${pico.cyan(res.pages)} 页${
                PICA_DL_FAV_PAGE
                    ? `, 第 ${pico.cyan(PICA_DL_FAV_PAGE)} 页等待下载`
                    : ''
            }`
        )
    }
    if (PICA_PRINT_FAVS) {
        const res = await pica.favoritesAll()
        const table = new Table({
            head: ['cid', 'title']
        })
        res.comics.forEach((item) => table.push([item._id, item.title]))
        console.log('收藏夹全部漫画信息：')
        console.log(table.toString())
    }

    if ((block || answer === 'recent') && answer !== 'leaderboard' && answer !== 'favorites') {
        const blockLabel = block || '全站（遍历全部分区）'
        spinner.start(`正在浏览 ${blockLabel} 的最新更新`)
        const r = block
            ? await searchBlock(
                  pica,
                  block,
                  recentHours,
                  excludeCategories,
                  includeCategories,
                  dropRaw,
                  limit,
                  strictRaw,
                  drops
              )
            : await searchAllBlocks(
                  pica,
                  recentHours,
                  excludeCategories,
                  includeCategories,
                  dropRaw,
                  limit,
                  strictRaw,
                  drops
              )
        spinner.stop()
        for (const c of r.kept) {
            comics.push(c)
        }
        log.info(
            `${blockLabel}：扫到 ${pico.cyan(r.scanned)} 本，保留 ${pico.cyan(r.kept.length)} 本` +
                (r.droppedRaw > 0 ? `，生肉剔除 ${pico.cyan(r.droppedRaw)} 本` : '') +
                (r.droppedCat > 0 ? `，分区排除 ${pico.cyan(r.droppedCat)} 本` : '') +
                (r.stale > 0 ? `，超时间窗 ${pico.cyan(r.stale)} 本` : '')
        )
        if (comics.length === 0) {
            log.warn('没有找到符合条件的漫画')
            return
        }
    }

    if (answer === 'search' && !block) {
        if (PICA_IN_GITHUB && !PICA_DL_SEARCH_KEYWORDS) {
            log.warn('没有输入搜索关键字')
            return
        }

        let searchRes: Comic[] = []

        const inputStr =
            PICA_DL_SEARCH_KEYWORDS ||
            (await Input({
                message: '请输入关键字或者漫画ID (多个用 # 隔开)',
                transformer: (val) => val.trim()
            }))

        if (!inputStr) {
            log.warn('没有输入搜索关键字')
            return
        }

        const inputKeys = inputStr
            .split('#')
            .map((s) => s.trim())
            .filter(Boolean)

        // 根据漫画ID查询
        const bookIds = inputKeys.filter((k: string) => isValidComicId(k))
        for (const id of bookIds) {
            try {
                const info = await pica.comicInfo(id)
                info.title = info.title.trim()
                comics.push(info)
                log.info(`${info.title} 已加入下载队列`)
            } catch (error) {
                log.error(`无效漫画ID ${id}`)
            }
        }

        // 根据关键字查询
        const keywords = inputKeys.filter((k: string) => !isValidComicId(k))

        if (recentHours !== null || limit > 0 || includeCategories.length > 0) {
            const seen = new Set<string>()
            const scopeDesc =
                recentHours !== null ? `近 ${recentHours} 小时` : limit > 0 ? `最新 ${limit} 部` : '全部'
            for (const keyword of keywords) {
                if (limit > 0 && comics.length >= limit) break
                spinner.start(`正在搜索 ${keyword}（${scopeDesc}）`)
                const r = await searchRecent(
                    pica,
                    keyword,
                    recentHours,
                    excludeCategories,
                    includeCategories,
                    dropRaw,
                    limit > 0 ? limit - comics.length : 0,
                    strictRaw,
                    drops
                )
                spinner.stop()
                let added = 0
                for (const c of r.kept) {
                    if (seen.has(c._id)) continue
                    seen.add(c._id)
                    comics.push(c)
                    added++
                    if (limit > 0 && comics.length >= limit) break
                }
                log.info(
                    `${keyword}：扫到 ${pico.cyan(r.scanned)} 本，新增 ${pico.cyan(added)} 本` +
                        (r.droppedRaw > 0 ? `，生肉剔除 ${r.droppedRaw} 本` : '') +
                        (r.droppedCat > 0 ? `，分区排除 ${r.droppedCat} 本` : '')
                )
            }
            if (comics.length === 0) {
                log.warn('没有找到符合条件的漫画')
            }
        } else {
            for (const keyword of keywords) {
                spinner.start(`正在搜索 ${keyword}`)
                searchRes = await pica.searchAll(keyword)
                spinner.stop()

                if (searchRes.length === 0) {
                    continue
                }

                const selected = PICA_DL_SEARCH_KEYWORDS
                    ? searchRes
                    : await Checkbox({
                          message: '请选择要下载的漫画',
                          pageSize: 10,
                          loop: false,
                          instructions: checkboxHelpTip,
                          choices: searchRes.map((x) => {
                              return {
                                  name: x.title.trim(),
                                  value: x
                              }
                          })
                      })
                comics.push(...selected)
            }
        }
    }

    // 全局过滤：生肉 + 分区排除 + 时间窗（对排行榜/收藏夹同样生效）
    let pool = comics
    if (dropRaw) {
        const before = pool.length
        pool = pool.filter((c) => {
            const raw = isRaw(c, strictRaw)
            if (raw) drops.push({ title: c.title, reason: strictRaw ? '生肉（严格：含无汉化组）' : '生肉标记', tags: comicTags(c) })
            return !raw
        })
        if (before !== pool.length) {
            log.info(`生肉过滤：剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (excludeCategories.length > 0) {
        const before = pool.length
        pool = pool.filter((c) => !hitExclude(c, excludeCategories))
        if (before !== pool.length) {
            log.info(`分区排除：再剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (recentHours !== null) {
        const before = pool.length
        pool = pool.filter((c) => isWithinHours(c.updated_at, recentHours))
        if (before !== pool.length) {
            log.info(`时间过滤：再剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (includeCategories.length > 0) {
        const before = pool.length
        pool = pool.filter((c) => hitInclude(c, includeCategories))
        if (before !== pool.length) {
            log.info(`分类限定：再剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (titleExclude.length > 0) {
        const before = pool.length
        pool = pool.filter((c) => {
            if (hitTitle(c, titleExclude)) {
                drops.push({ title: c.title, reason: '标题命中排除词', tags: comicTags(c) })
                return false
            }
            return true
        })
        if (before !== pool.length) {
            log.info(`标题排除：再剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (titleInclude.length > 0) {
        const before = pool.length
        pool = pool.filter((c) => {
            if (!hitTitle(c, titleInclude)) {
                drops.push({ title: c.title, reason: '标题未命中限定词', tags: comicTags(c) })
                return false
            }
            return true
        })
        if (before !== pool.length) {
            log.info(`标题限定：再剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (pickIds.size > 0) {
        const before = pool.length
        pool = pool.filter((c) => pickIds.has(c._id))
        if (before !== pool.length) {
            log.info(`指定清单：按 id 再剔除 ${pico.cyan(before - pool.length)} 本`)
        }
    }
    if (limit > 0) {
        pool.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        if (pool.length > limit) {
            log.info(`数量截断：保留最新 ${pico.cyan(limit)} 部`)
            pool = pool.slice(0, limit)
        }
    }

    if (debugDrops && drops.length > 0) {
        const shown = drops.slice(0, 40)
        log.info(`被过滤明细（共 ${drops.length} 条，显示前 ${shown.length} 条）：`)
        for (const d of shown) {
            log.info(`  - [${d.reason}] ${d.title}  「${d.tags}」`)
        }
        if (drops.length > shown.length) {
            log.info(`  ... 还有 ${drops.length - shown.length} 条未显示`)
        }
    }

    if (pool.length === 0) {
        log.log('没有找到相应的漫画')
        return
    }

    // 打印最终清单
    const listTable = new Table({
        head: ['#', '标题', '更新时间', '分区']
    })
    pool.forEach((c, i) => {
        listTable.push([
            String(i + 1),
            (c.title || '').trim().slice(0, 40),
            (c.updated_at || '').slice(0, 19).replace('T', ' '),
            (c.categories || []).join('/')
        ])
    })
    console.log(listTable.toString())

    log.info(`${pico.cyan(pool.length)} 部漫画等待下载`)

    if (dryRun) {
        // 干跑：把清单以机器可读形式吐出来，网页端解析这个 JSON 展示
        const preview = pool.map((c) => ({
            id: c._id,
            title: (c.title || '').trim(),
            updated: (c.updated_at || '').slice(0, 19).replace('T', ' '),
            categories: c.categories || [],
            tags: c.tags || [],
            author: c.author || '',
            pages: (c as any).pagesCount || 0
        }))
        console.log('__PREVIEW_JSON__' + JSON.stringify(preview))
        log.info('干跑模式：只打印清单，不下载')
        return
    }

    for (const comic of pool) {
        const title = comic.title.trim()
        const cid = comic._id

        spinner.start('正在获取章节信息')
        let episodes = await withRetry(
            () => pica.episodesAll(cid),
            `「${title}」获取章节`,
            2
        ).catch((error) => {
            if (error === 400) {
                spinner.stop()
                log.error(`「${title}」无法访问，可能已被哔咔禁止`)
            } else {
                spinner.stop()
                log.warn(
                    `「${title}」获取章节失败（${(error as Error)?.message || error}），跳过该漫画`
                )
            }
            return []
        })
        episodes = filterEpisodes(episodes, cid)
        spinner.stop()

        if (episodes.length === 0) {
            continue
        }

        log.info(`${title} 查询到 ${pico.cyan(episodes.length)} 个未下载章节`)

        const selectedEpisodes = PICA_DL_CHAPTER
            ? selectChapterByInput(PICA_DL_CHAPTER, episodes)
            : PICA_IN_GITHUB
              ? episodes
              : await Checkbox({
                    message: '请选择要下载的章节',
                    pageSize: 10,
                    loop: false,
                    instructions: checkboxHelpTip,
                    choices: episodes.map((ep) => {
                        return {
                            name: ep.title,
                            value: ep
                        }
                    })
                })

        if (selectedEpisodes.length === 0) {
            continue
        }

        const prefix = pico.bold(`[${title}]`)
        const epTotal = selectedEpisodes.length
        let epCurrent = 0
        let picCurrent = 0
        let picTotal = 0

        const bar = new ProgressBar(
            `${prefix} ${pico.green('{bar}')} {percentage}% | {value}/{total}`,
            {
                clear: true,
                complete: '=',
                incomplete: ' ',
                width: 20,
                total: 100
            }
        )

        log.info(`${title} 正在下载 ${pico.cyan(epTotal)} 个章节`)

        const limit = pLimit(Number(PICA_DL_CONCURRENCY) || 5)

        for (const ep of selectedEpisodes) {
            epCurrent += 1
            spinner.start(`${prefix} 正在获取章节图片`)
            let pictures: Awaited<ReturnType<typeof pica.picturesAll>> = []
            try {
                pictures = await withRetry(
                    () => pica.picturesAll(cid, ep),
                    `${prefix} ${ep.title} 获取图片列表`,
                    2
                )
            } catch (err) {
                spinner.stop()
                bar.terminate()
                log.error(
                    `${prefix} ${ep.title} 获取图片列表失败（${(err as Error)?.message || err}），跳过该章节`
                )
                continue
            }
            pictures = filterPictures(pictures, title, ep.title)
            spinner.stop()

            if (pictures.length === 0) {
                continue
            }

            picCurrent = 0
            picTotal = pictures.length

            bar.update(0)

            const failed: string[] = []

            // 单张图片失败重试 3 次，仍失败则记为残缺、不中断整轮
            const pics = pictures.map((pic) =>
                limit(async () => {
                    try {
                        await withRetry(
                            () =>
                                pica.download(pic.url, {
                                    title,
                                    epTitle: ep.title,
                                    picName: pic.name
                                }),
                            `${prefix} ${ep.title} ${pic.name}`,
                            3
                        )
                    } catch (err) {
                        failed.push(pic.name)
                        log.warn(
                            `${prefix} ${ep.title} ${pic.name} 下载失败（${(err as Error)?.message || err}），已跳过`
                        )
                    }
                    picCurrent += 1
                    bar.update((picCurrent / picTotal) * 100)
                })
            )

            await Promise.all(pics)
            bar.terminate()

            if (failed.length === 0) {
                mark(cid, ep.id)
                log.info(
                    `${prefix} ${pico.green('✓')} ${ep.title} 下载完成 (${epCurrent}/${epTotal})`
                )
            } else {
                // 有缺图就不写 done，下次跑还能补
                log.warn(
                    `${prefix} ${ep.title} 完成但有 ${failed.length} 张失败（${failed.slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}），不记为已完成`
                )
            }
        }
    }

    log.info(`全部下载完成`)
}

main().catch((err) => {
    log.error(err?.message || String(err))
    process.exit(1)
})
