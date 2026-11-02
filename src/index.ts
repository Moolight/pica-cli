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

/** 生肉标记：标题/标签/分区里出现这些词就判定为未汉化 */
const RAW_MARKERS = ['生肉', '日文', '日本語', '日語', '无汉化', '無漢化', 'raw', 'untranslated']

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

function isWithinHours(updatedAt: string, hours: number): boolean {
    const t = Date.parse(updatedAt)
    if (!Number.isFinite(t)) return false
    return Date.now() - t <= hours * 3600 * 1000
}

function hitExclude(comic: Comic, exclude: string[]): boolean {
    if (exclude.length === 0) return false
    const fields = [
        ...(comic.categories || []),
        ...(comic.tags || []),
        comic.title || ''
    ].join('|').toLowerCase()
    return exclude.some((e) => fields.includes(e.toLowerCase()))
}

function isRaw(comic: Comic): boolean {
    const fields = [
        comic.title || '',
        ...(comic.categories || []),
        ...(comic.tags || [])
    ].join('|').toLowerCase()
    if (RAW_MARKERS.some((m) => fields.includes(m.toLowerCase()))) return true
    // chineseTeam 为空 = 没有汉化组
    const team = (comic.chineseTeam || '').trim()
    if (!team) return true
    return false
}

/**
 * 带时间窗的搜索：用 dd（新到旧）排序，遇到整页都超出时间窗就停
 */
async function searchRecent(
    pica: Pica,
    keyword: string,
    hours: number,
    exclude: string[]
): Promise<{ kept: Comic[]; droppedRaw: number; droppedCat: number; scanned: number }> {
    const kept: Comic[] = []
    let droppedRaw = 0
    let droppedCat = 0
    let scanned = 0
    const maxPage = 20
    for (let page = 1; page <= maxPage; page++) {
        const res = await pica.search(keyword, page, pica.Order.latest)
        if (!res.docs || res.docs.length === 0) break
        let freshOnPage = 0
        for (const c of res.docs) {
            if (!isWithinHours(c.updated_at, hours)) continue
            freshOnPage++
            scanned++
            if (hitExclude(c, exclude)) {
                droppedCat++
                continue
            }
            kept.push(c)
        }
        if (freshOnPage === 0) break
        if (freshOnPage < res.docs.length) break
        if (page >= res.pages) break
    }
    return { kept, droppedRaw, droppedCat, scanned }
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
    const dropRaw = process.env.PICA_DL_DROP_RAW !== 'false'

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

    const answer =
        PICA_DL_CONTENT ||
        (await Select({
            message: '想下载哪些漫画？',
            choices: [
                { name: '去搜索', value: 'search' },
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

    if (answer === 'search') {
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

        if (recentHours !== null) {
            const seen = new Set<string>()
            for (const keyword of keywords) {
                spinner.start(`正在搜索 ${keyword}（近 ${recentHours} 小时）`)
                const r = await searchRecent(pica, keyword, recentHours, excludeCategories)
                spinner.stop()
                let added = 0
                for (const c of r.kept) {
                    if (seen.has(c._id)) continue
                    seen.add(c._id)
                    comics.push(c)
                    added++
                }
                log.info(
                    `${keyword}：时间窗内 ${pico.cyan(r.scanned)} 本，新增 ${pico.cyan(added)} 本` +
                        (r.droppedCat > 0 ? `，分区排除 ${r.droppedCat} 本` : '')
                )
            }
            if (comics.length === 0) {
                log.warn('时间窗内没有找到符合条件的漫画')
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
        pool = pool.filter((c) => !isRaw(c))
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

    for (const comic of pool) {
        const title = comic.title.trim()
        const cid = comic._id

        spinner.start('正在获取章节信息')
        let episodes = await pica.episodesAll(cid).catch((error) => {
            if (error === 400) {
                spinner.stop()
                log.error(`「${title}」无法访问，可能已被哔咔禁止`)
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
            let pictures = await pica.picturesAll(cid, ep)
            pictures = filterPictures(pictures, title, ep.title)
            spinner.stop()

            if (pictures.length === 0) {
                continue
            }

            picCurrent = 0
            picTotal = pictures.length

            bar.update(0)

            const pics = pictures.map((pic) =>
                limit(async () => {
                    await pica.download(pic.url, {
                        title,
                        epTitle: ep.title,
                        picName: pic.name
                    })
                    picCurrent += 1
                    bar.update((picCurrent / picTotal) * 100)
                })
            )

            await Promise.all(pics)
            bar.terminate()

            mark(cid, ep.id)
            log.info(
                `${prefix} ${pico.green('✓')} ${ep.title} 下载完成 (${epCurrent}/${epTotal})`
            )
        }
    }

    log.info(`全部下载完成`)
}

main().catch((err) => {
    log.error(err?.message || String(err))
    process.exit(1)
})
