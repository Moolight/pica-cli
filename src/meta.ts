import fs from 'node:fs'
import path from 'node:path'
import pico from 'picocolors'
import { Pica } from './sdk'
import { log, loadEnv, normalizeName } from './utils'

loadEnv()

/** 简繁/大小写无关的粗归一，用来挑最佳匹配 */
function norm(s: string) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s\-_·:：!！?？'"“”‘’()（）\[\]【】<>《》/\\|,，.。~～]/g, '')
}

function pickBest(docs: any[], title: string) {
    const want = norm(title)
    if (!want) return null
    // 1) 完全一致
    let hit = docs.find((d) => norm(d.title) === want)
    if (hit) return hit
    // 2) 互相包含（防止标题被截断 / 后缀不同）
    hit = docs.find((d) => {
        const t = norm(d.title)
        return t && (t.includes(want) || want.includes(t))
    })
    return hit || null
}

async function main() {
    const raw = process.env.PICA_META_TITLES || ''
    const titles = raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)

    if (titles.length === 0) {
        log.warn('没有收到标题清单（PICA_META_TITLES 为空）')
        return
    }

    const outDir = path.resolve(process.cwd(), 'meta-out')
    fs.mkdirSync(outDir, { recursive: true })

    const pica = new Pica()
    await pica.login(process.env.PICA_ACCOUNT!, process.env.PICA_PASSWORD!)
    log.info(`登录完成，待查元信息 ${pico.cyan(String(titles.length))} 本`)

    let ok = 0
    let miss = 0
    let err = 0
    const missing: string[] = []

    for (let i = 0; i < titles.length; i++) {
        const title = titles[i]
        const tag = `[${i + 1}/${titles.length}]`
        try {
            const page = await pica.search(title, 1)
            const docs = page?.docs || []
            const hit = pickBest(docs, title)
            if (!hit) {
                miss++
                missing.push(title)
                log.warn(`${tag} 没找到：${title}`)
                continue
            }
            const meta = {
                id: hit._id || '',
                title: hit.title || title,
                query: title,
                matched: norm(hit.title) === norm(title),
                author: hit.author || '',
                categories: hit.categories || [],
                tags: hit.tags || [],
                description: hit.description || '',
                chineseTeam: hit.chineseTeam || '',
                finished: !!hit.finished,
                totalViews: hit.totalViews || 0,
                totalLikes: hit.totalLikes || 0,
                pages: (hit as any).pagesCount || 0,
                updated_at: hit.updated_at || '',
                created_at: hit.created_at || ''
            }
            const fname = normalizeName(title) + '.json'
            fs.writeFileSync(path.join(outDir, fname), JSON.stringify(meta, null, 2), 'utf8')
            ok++
        } catch (e: any) {
            err++
            log.warn(`${tag} 查询失败：${title}（${e?.message || e}）`)
        }
        // 轻量节流，别把对面打急了
        await new Promise((r) => setTimeout(r, 250))
    }

    log.info(`完成：命中 ${pico.green(String(ok))}，没找到 ${pico.yellow(String(miss))}，出错 ${pico.red(String(err))}`)
    if (missing.length > 0 && missing.length <= 40) {
        log.info('没找到的：' + missing.join('、'))
    }
}

main().catch((e) => {
    log.error(e?.message || String(e))
    process.exit(1)
})
