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

/**
 * 把目录名拆成若干个可搜索的候选词。
 * 本地目录名常带 `︱` `／` 之类的双语分隔符，整串拿去搜是搜不到的。
 */
function queryCandidates(title: string) {
    const seps = /[︱|｜/／]/
    const parts = title
        .split(seps)
        .map((s) => s.trim())
        .filter(Boolean)
    const out: string[] = []
    // 先整串（能搜到最好，最准）
    out.push(title.trim())
    // 再逐段，长的优先
    parts
        .slice()
        .sort((a, b) => b.length - a.length)
        .forEach((p) => {
            if (p !== title.trim()) out.push(p)
        })
    return Array.from(new Set(out.filter(Boolean)))
}

function pickBest(docs: any[], title: string) {
    const full = norm(title)
    if (!full) return null
    // 1) 整串完全一致
    let hit = docs.find((d) => norm(d.title) === full)
    if (hit) return hit
    // 2) 整串互相包含
    hit = docs.find((d) => {
        const t = norm(d.title)
        return t && (t.includes(full) || full.includes(t))
    })
    if (hit) return hit
    // 3) 按分隔符拆段，任一段命中就算（双语标题常见）
    const pieces = title
        .split(/[︱|｜/／]/)
        .map((s) => norm(s))
        .filter((s) => s.length >= 4)
    for (const p of pieces) {
        hit = docs.find((d) => {
            const t = norm(d.title)
            return t && (t === p || t.includes(p) || p.includes(t))
        })
        if (hit) return hit
    }
    return null
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
        let hit: any = null
        try {
            for (const q of queryCandidates(title)) {
                const page = await pica.search(q, 1)
                const docs = page?.docs || []
                hit = pickBest(docs, title)
                if (hit) break
                await new Promise((r) => setTimeout(r, 200))
            }
            if (!hit) {
                miss++
                missing.push(title)
                log.warn(`${tag} 没找到：${title}`)
                continue
            }
            const meta = {
                id: hit._id || '',
                title: hit.title || title,
                localName: title,
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
            // 文件名按「本地书名」来，本机才能对上号
            const fname = normalizeName(title) + '.json'
            fs.writeFileSync(path.join(outDir, fname), JSON.stringify(meta, null, 2), 'utf8')
            ok++
        } catch (e: any) {
            err++
            log.warn(`${tag} 查询失败：${title}（${e?.message || e}）`)
        }
        await new Promise((r) => setTimeout(r, 250))
    }

    log.info(
        `完成：命中 ${pico.green(String(ok))}，没找到 ${pico.yellow(String(miss))}，出错 ${pico.red(String(err))}`
    )
    if (missing.length > 0 && missing.length <= 40) {
        log.info('没找到的：' + missing.join('、'))
    }
}

main().catch((e) => {
    log.error(e?.message || String(e))
    process.exit(1)
})
