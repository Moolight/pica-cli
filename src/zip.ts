import AdmZip from 'adm-zip'
import path from 'node:path'
import fs from 'node:fs'
import ProgressBar from 'progress'
import pico from 'picocolors'
import { log } from './utils'

function main() {
    const root = path.resolve(process.cwd(), 'comics')
    const dest = path.resolve(process.cwd(), 'comics-zip')

    if (!fs.existsSync(root)) {
        log.warn('没有发现已下载的漫画')
        return
    }

    const comics = fs.readdirSync(root).filter((d) => {
        return fs.statSync(path.join(root, d)).isDirectory()
    })

    if (comics.length === 0) {
        log.warn('没有发现已下载的漫画')
        return
    }

    log.info(`${comics.length}本漫画等待打包：${pico.cyan(comics.join(', '))}`)

    for (const comic of comics) {
        const comicRoot = path.join(root, comic)
        const episodes = fs.readdirSync(comicRoot).filter((name) => {
            // _meta.json 是元信息文件，不是章节，别当章节打包
            return name !== '_meta.json'
        })

        // 元信息单独放到 <书名>/_meta.json，本机解压时认它
        const metaSrc = path.join(comicRoot, '_meta.json')
        if (fs.existsSync(metaSrc)) {
            const dir = path.join(dest, comic)
            fs.mkdirSync(dir, { recursive: true })
            fs.copyFileSync(metaSrc, path.join(dir, '_meta.json'))
        }

        const bar = new ProgressBar(
            `${pico.cyan('➡️')} 打包 ${pico.cyan(comic)} [:bar] :percent`,
            {
                incomplete: ' ',
                width: 20,
                total: episodes.length
            }
        )

        for (const ep of episodes) {
            const dir = path.join(dest, comic)
            fs.mkdirSync(dir, { recursive: true })

            const zip = new AdmZip()
            zip.addLocalFolder(path.join(comicRoot, ep))
            zip.writeZip(path.join(dir, `${ep}.zip`))

            bar.tick()
        }

        // log.success(`${comic} 打包完成`)
    }

    log.success(`打包完成`)
}

main()
