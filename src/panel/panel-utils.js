// src/panel/panel-utils.js
// Pure stateless DOM, IPC, SVG, theme, typography & file-export utilities for Datanoa Side Panel.

import { GEIST_FONT_DATA_URI } from '../assets/geist-font.js'
import { openSharedFilePickerModal } from '../shared-file-picker.js'
import { sanitizeJson, srgbLin } from './panel-core.js'

if (
  typeof document !== 'undefined' &&
  document.head &&
  !document.getElementById('datanoa-geist-font')
) {
  const fontStyle = document.createElement('style')
  fontStyle.id = 'datanoa-geist-font'
  fontStyle.textContent = `@font-face { font-family: 'OrcaDesktopSans'; src: url('${GEIST_FONT_DATA_URI}') format('woff2'); font-weight: 100 900; font-style: normal; font-display: block; }`
  document.head.prepend(fontStyle)
}

export const DB_SVG_MARKUP = {
  sqlite: '<svg class="db-svg db-sqlite" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z"></path></svg>',
  postgres: '<svg class="db-svg db-postgres" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z"></path></svg>',
  mysql: '<svg class="db-svg db-mysql" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.25 5.39c-0.25 0 -0.42 0.03 -0.6 0.07v0.03h0.03c0.12 0.23 0.32 0.4 0.47 0.6c0.12 0.24 0.22 0.47 0.34 0.7l0.03 -0.03c0.21 -0.15 0.31 -0.38 0.31 -0.73c-0.09 -0.1 -0.1 -0.21 -0.18 -0.31c-0.09 -0.15 -0.28 -0.22 -0.4 -0.34zM21.26 18.18c-1.18 -0.03 -2.09 0.09 -2.86 0.41c-0.22 0.09 -0.57 0.09 -0.6 0.37c0.12 0.12 0.14 0.31 0.24 0.47c0.18 0.3 0.48 0.69 0.76 0.9c0.31 0.24 0.62 0.48 0.94 0.68c0.57 0.35 1.22 0.56 1.78 0.92c0.32 0.21 0.65 0.47 0.97 0.69c0.16 0.11 0.26 0.31 0.47 0.38v-0.04c-0.1 -0.13 -0.13 -0.32 -0.23 -0.47c-0.15 -0.15 -0.3 -0.28 -0.44 -0.42a7.1 7.1 0 0 0 -1.53 -1.49c-0.47 -0.32 -1.5 -0.77 -1.7 -1.31l-0.03 -0.03c0.32 -0.03 0.7 -0.15 1.01 -0.23c0.5 -0.13 0.96 -0.1 1.48 -0.23c0.23 -0.06 0.47 -0.13 0.7 -0.21v-0.13c-0.26 -0.26 -0.46 -0.62 -0.74 -0.87a19.52 19.52 0 0 0 -2.43 -1.81c-0.46 -0.3 -1.05 -0.48 -1.53 -0.74c-0.18 -0.09 -0.47 -0.13 -0.57 -0.28c-0.26 -0.32 -0.42 -0.75 -0.61 -1.13a38.95 38.95 0 0 1 -1.2 -2.56c-0.26 -0.58 -0.42 -1.15 -0.75 -1.68c-1.52 -2.5 -3.16 -4.02 -5.69 -5.5c-0.54 -0.31 -1.2 -0.44 -1.88 -0.6c-0.37 -0.02 -0.74 -0.04 -1.1 -0.06c-0.24 -0.1 -0.48 -0.38 -0.68 -0.52c-0.84 -0.53 -3 -1.67 -3.62 -0.16c-0.4 0.96 0.59 1.9 0.93 2.38c0.25 0.34 0.57 0.72 0.75 1.1c0.1 0.26 0.13 0.52 0.24 0.78c0.23 0.65 0.46 1.37 0.76 1.97c0.16 0.31 0.34 0.63 0.54 0.91c0.12 0.16 0.32 0.24 0.37 0.5c-0.21 0.3 -0.22 0.74 -0.34 1.1c-0.53 1.67 -0.32 3.73 0.43 4.95c0.24 0.37 0.8 1.18 1.55 0.87c0.66 -0.26 0.52 -1.1 0.7 -1.84c0.04 -0.18 0.02 -0.29 0.11 -0.41v0.03c0.21 0.41 0.41 0.81 0.6 1.22c0.45 0.72 1.25 1.47 1.91 1.97c0.35 0.26 0.63 0.72 1.07 0.89v-0.04h-0.03c-0.09 -0.13 -0.22 -0.19 -0.34 -0.29a7.59 7.59 0 0 1 -0.77 -0.88a19.29 19.29 0 0 1 -1.64 -2.68c-0.24 -0.46 -0.44 -0.96 -0.64 -1.42c-0.09 -0.18 -0.09 -0.44 -0.24 -0.53c-0.22 0.32 -0.54 0.6 -0.7 1c-0.28 0.63 -0.31 1.41 -0.41 2.22c-0.06 0.02 -0.03 0 -0.06 0.03c-0.47 -0.11 -0.63 -0.6 -0.81 -1.01c-0.44 -1.05 -0.51 -2.73 -0.13 -3.93c0.1 -0.31 0.54 -1.28 0.37 -1.58c-0.09 -0.28 -0.38 -0.44 -0.54 -0.67a5.46 5.46 0 0 1 -0.53 -0.94c-0.35 -0.82 -0.53 -1.73 -0.91 -2.56c-0.18 -0.38 -0.48 -0.78 -0.74 -1.13c-0.28 -0.4 -0.59 -0.68 -0.81 -1.14c-0.07 -0.16 -0.18 -0.43 -0.06 -0.6c0.03 -0.12 0.09 -0.17 0.21 -0.2c0.19 -0.16 0.74 0.05 0.93 0.14c0.54 0.22 1 0.43 1.46 0.74c0.21 0.15 0.43 0.42 0.69 0.5h0.31c0.47 0.1 1 0.03 1.44 0.16c0.78 0.25 1.49 0.62 2.12 1.01a13.11 13.11 0 0 1 4.59 5.03c0.18 0.34 0.25 0.65 0.41 1c0.31 0.73 0.69 1.46 1 2.16c0.31 0.69 0.61 1.4 1.05 1.97c0.22 0.31 1.11 0.47 1.5 0.63c0.29 0.13 0.75 0.25 1.01 0.41c0.51 0.31 1 0.66 1.48 1c0.24 0.17 0.98 0.54 1.02 0.83z"></path></svg>',
  mariadb: '<svg class="db-svg db-mariadb" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.157 4.412c-.676.284-.79.31-1.673.372-.65.045-.757.057-1.212.209-.75.246-1.395.75-2.02 1.59-.296.398-1.249 1.913-1.249 1.988 0 .057-.65.998-.915 1.32-.574.713-1.08 1.079-2.14 1.59-.77.36-1.224.524-4.102 1.477-1.073.353-2.133.738-2.367.864-.852.449-1.515 1.036-2.203 1.938-1.003 1.32-.972 1.313-3.042.947a12.264 12.264 0 00-.675-.063c-.644-.05-1.023.044-1.332.334L0 17.193l.177.088c.094.05.353.234.561.398.215.17.461.347.55.391.088.044.17.088.183.101.012.013-.089.17-.228.353-.435.581-.593.871-.574 1.048.019.164.032.17.43.17.517-.006.826-.056 1.261-.208.65-.233 2.058-.94 2.784-1.4.776-.5 1.717-.998 1.956-1.042.082-.02.354-.07.594-.114.58-.107 1.464-.095 2.587.05.108.013.373.045.6.064.227.025.43.057.454.076.026.012.474.037.998.056.934.026 1.104.007 1.3-.189.126-.133.385-.631.498-.985.209-.643.417-.921.366-.492-.113.966-.322 1.692-.713 2.411-.259.499-.663 1.092-.934 1.395-.322.347-.315.36.088.315.619-.063 1.471-.397 2.096-.82.827-.562 1.647-1.691 2.19-3.03.107-.27.22-.22.183.083-.013.094-.038.315-.057.498l-.031.328.353-.202c.833-.48 1.414-1.262 2.127-2.884.227-.518.877-2.922 1.073-3.976a9.64 9.64 0 01.271-1.042c.127-.429.196-.555.48-.858.183-.19.625-.555.978-.808.72-.505.953-.75 1.187-1.205.208-.417.284-1.13.132-1.357-.132-.202-.284-.196-.763.006Z"></path></svg>',
  cockroachdb: '<svg class="db-svg db-cockroachdb" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.645 16.155a13.013 13.013 0 0 0-4.479-13.287 11.617 11.617 0 0 1 5.815-1.546c.774 0 1.545.075 2.304.226l.32-1.282A13.092 13.092 0 0 0 18.98 0 12.93 12.93 0 0 0 12 2.03 12.933 12.933 0 0 0 5.021 0C4.139 0 3.26.089 2.396.266l.319 1.282a11.83 11.83 0 0 1 2.306-.226 11.64 11.64 0 0 1 5.817 1.544 13.01 13.01 0 0 0 .792 20.877l.375.257.373-.257c2.624-1.801 4.5-4.5 5.27-7.588zm-6.305 5.7A11.687 11.687 0 0 1 7.825 9.519a13.08 13.08 0 0 0 2.457 2.977 3.202 3.202 0 0 1 1.058 2.383zm.661-9.657a11.717 11.717 0 0 1-2.343-2.315 3.23 3.23 0 0 1 0-3.912 11.67 11.67 0 0 1 2.347-2.333c.9.671 1.697 1.468 2.37 2.366a3.197 3.197 0 0 1 0 3.832 11.816 11.816 0 0 1-2.374 2.362zm.659 9.657v-6.976a3.202 3.202 0 0 1 1.06-2.383 13.026 13.026 0 0 0 2.455-2.977 11.694 11.694 0 0 1-3.515 12.336Z"></path></svg>',
  clickhouse: '<svg class="db-svg db-clickhouse" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="0" y="1.335" width="2.667" height="18.665"></rect><rect x="0" y="20" width="2.667" height="2.665" fill="#ff0000"></rect><rect x="5.333" y="1.335" width="2.667" height="21.33"></rect><rect x="10.667" y="1.335" width="2.666" height="21.33"></rect><rect x="16" y="1.335" width="2.667" height="21.33"></rect><rect x="21.333" y="10" width="2.667" height="4"></rect></svg>',
  redis: '<svg class="db-svg db-redis" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10.5 2.661l.54.997-1.797.644 2.409.218.748 1.246.467-1.121 2.077-.208-1.61-.613.426-1.017-1.578.519zm6.905 2.077L13.76 6.182l3.292 1.298.353-.146 3.293-1.298zm-10.51.312a2.97 1.153 0 0 0-2.97 1.152 2.97 1.153 0 0 0 2.97 1.153 2.97 1.153 0 0 0 2.97-1.153 2.97 1.153 0 0 0-2.97-1.152zM24 6.805s-8.983 4.278-10.395 4.953c-1.226.561-1.901.561-3.261.094C8.318 11.022 0 7.241 0 7.241v1.038c0 .24.332.499.966.8 1.277.613 8.34 3.677 9.45 4.206 1.112.53 1.9.54 3.313-.197 1.412-.738 8.049-3.905 9.326-4.57.654-.342.945-.602.945-.84zm-10.042.602L8.39 8.26l3.884 1.61zM24 10.637s-8.983 4.279-10.395 4.954c-1.226.56-1.901.56-3.261.093C8.318 14.854 0 11.074 0 11.074v1.038c0 .238.332.498.966.8 1.277.612 8.34 3.676 9.45 4.205 1.112.53 1.9.54 3.313-.197 1.412-.737 8.049-3.905 9.326-4.57.654-.332.945-.602.945-.84zm0 3.842l-10.395 4.954c-1.226.56-1.901.56-3.261.094C8.318 18.696 0 14.916 0 14.916v1.038c0 .239.332.499.966.8 1.277.613 8.34 3.676 9.45 4.206 1.112.53 1.9.54 3.313-.198 1.412-.737 8.049-3.904 9.326-4.569.654-.343.945-.613.945-.841z"></path></svg>',
  libsql: '<svg class="db-svg db-libsql" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m23.31.803-.563-.42-1.11 1.189-.891-1.286-.512.235.704 1.798-.326.35L18.082 0l-.574.284 2.25 4.836-2.108.741h-.05l-1.143-1.359-1.144 1.36H8.687l-1.144-1.36-1.146 1.363H6.36l-2.12-.745L6.491.284 5.919 0l-2.53 2.668-.327-.349.705-1.798-.512-.236-.89 1.287L1.253.382.69.804 2.42 3.69l-.89.939.311 2.375 2.061.787L3.9 8.817H1.947v.444l.755 1.078 1.197.433v6.971l3.057 4.55L7.657 24l1.101-1.606L9.9 24l.999-1.606L12 24l1.102-1.606L14.1 24l1.141-1.606L16.343 24l.701-1.706 3.058-4.55v-6.972l1.196-.433.756-1.078v-.444h-1.952l.003-1.03 2.054-.784.311-2.375-.89-.939zm-8.93 18.718H8.033l.793-1.615.794 1.615.793-1.083.793 1.083.794-1.083.793 1.083.794-1.083.793 1.083.793-1.615.794 1.615zm3.886-7.39-3.3 1.084-.143 3.061-2.827.627-2.826-.627-.142-3.06-3.3-1.085v-1.635l4.266 1.21-.052 4.126h4.109l-.052-4.127 4.266-1.209z"></path></svg>',
  d1: '<svg class="db-svg db-d1" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"></path></svg>',
  mssql: '<svg class="db-svg db-mssql" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color: #cc2927" aria-hidden="true"><path d="M12 2C6.48 2 2 3.79 2 6v12c0 2.21 4.48 4 10 4s10-1.79 10-4V6c0-2.21-4.48-4-10-4zm0 2c4.42 0 8 1.12 8 2s-3.58 2-8 2-8-1.12-8-2 3.58-2 8-2zm8 14c0 .88-3.58 2-8 2s-8-1.12-8-2v-2.23c1.82.9 4.71 1.48 8 1.48s6.18-.58 8-1.48V18zm0-4c0 .88-3.58 2-8 2s-8-1.12-8-2v-2.23c1.82.9 4.71 1.48 8 1.48s6.18-.58 8-1.48V14zm0-4c0 .88-3.58 2-8 2s-8-1.12-8-2V7.77C5.82 8.67 8.71 9.25 12 9.25s6.18-.58 8-1.48V10z"></path></svg>',
  oracle: '<svg class="db-svg db-oracle" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color: #f80000" aria-hidden="true"><path d="M7.641 6.727a5.273 5.273 0 1 0 0 10.546h8.718a5.273 5.273 0 1 0 0-10.546H7.641zm8.56 8.673H7.799a3.4 3.4 0 1 1 0-6.8h8.402a3.4 3.4 0 1 1 0 6.8z"></path></svg>',
  mongodb: '<svg class="db-svg db-mongodb" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color: #47a248" aria-hidden="true"><path d="M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"></path></svg>',
  custom: '<svg class="db-svg db-custom" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color: #a855f7" aria-hidden="true"><path d="M9 2v4H6a2 2 0 0 0-2 2v4c0 3.87 3.13 7 7 7v3h2v-3c3.87 0 7-3.13 7-7V8a2 2 0 0 0-2-2h-3V2h-2v4h-2V2H9zm-3 6h12v4a5 5 0 0 1-10 0V8z"></path></svg>',
}

export function getDbLogoSvg(driver, size = 14) {
  const safe = Object.prototype.hasOwnProperty.call(DB_SVG_MARKUP, driver) ? driver : 'sqlite'
  const safeSize = Number.isFinite(Number(size)) ? Math.max(8, Math.min(64, Math.round(Number(size)))) : 14
  return DB_SVG_MARKUP[safe].replace(/width="14" height="14"/, `width="${safeSize}" height="${safeSize}"`)
}

export function setDbLogoElement(container, driver, size = 14) {
  container.innerHTML = getDbLogoSvg(driver, size)
}

export async function rpc(name, input, options) {
  const payload = input === undefined ? undefined : sanitizeJson(input)
  if (window.orca?.plugin?.request) {
    if (options) {
      return await window.orca.plugin.request(name, payload === undefined ? {} : payload, options)
    }
    return payload === undefined
      ? await window.orca.plugin.request(name)
      : await window.orca.plugin.request(name, payload)
  }
  if (window.orca?.host?.call) {
    const params = { name }
    if (payload !== undefined) params.input = payload
    if (options?.timeoutMs) params.timeoutMs = options.timeoutMs
    const res = await window.orca.host.call('plugin.request', params)
    return res?.output
  }
  throw new Error('Orca IPC bridge is unavailable')
}

export function syncThemeFromTokens() {
  try {
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.background = 'var(--orca-background, #000000)'
    document.body.appendChild(probe)
    const bg = getComputedStyle(probe).backgroundColor
    probe.remove()
    const m = bg.match(/[\d.]+/g)
    if (!m || (m.length > 3 && Number(m[3]) === 0)) return
    const lum = 0.2126 * srgbLin(Number(m[0])) + 0.7152 * srgbLin(Number(m[1])) + 0.0722 * srgbLin(Number(m[2]))
    document.documentElement.classList.toggle('light', lum > 0.45)
  } catch {}
}

export function applyTypographySnapshot(typo) {
  if (!typo) return
  const root = document.documentElement
  if (typo.cssFontFamily) {
    root.style.setProperty('--mono', typo.cssFontFamily)
  }
}

export async function syncOrcaTypography() {
  try {
    if (window.orca?.host?.call) {
      const typo = await window.orca.host.call('editor.readTypography')
      applyTypographySnapshot(typo)
    }
  } catch {}
}

export function makeTableKey(connectionId, tableName, schemaName) {
  return `${connectionId || 'none'}:${schemaName || ''}:${tableName || ''}`
}

export function encodeTableSelectValue(schemaName, tableName) {
  return `${schemaName || ''}\0${tableName || ''}`
}

export function decodeTableSelectValue(encoded) {
  const raw = String(encoded || '')
  const sep = raw.indexOf('\0')
  if (sep < 0) return { schema: undefined, name: raw }
  const sch = raw.slice(0, sep)
  return { schema: sch || undefined, name: raw.slice(sep + 1) }
}

export function setButtonLoading(btn, isLoading, loadingText) {
  if (!btn) return
  if (isLoading) {
    if (btn.dataset.origHtml === undefined) {
      btn.dataset.origHtml = btn.innerHTML
      btn.dataset.origText = btn.textContent || ''
    }
    btn.disabled = true
    btn.setAttribute('aria-busy', 'true')
    btn.classList.add('is-loading')
    btn.textContent = ''
    const sp = document.createElement('span')
    sp.className = 'btn-spinner'
    sp.setAttribute('aria-hidden', 'true')
    btn.appendChild(sp)
    const labelText = loadingText !== undefined ? loadingText : btn.dataset.origText
    if (labelText) {
      const lbl = document.createElement('span')
      lbl.className = 'btn-loading-label'
      lbl.textContent = labelText
      btn.appendChild(lbl)
    }
  } else {
    btn.disabled = false
    btn.removeAttribute('aria-busy')
    btn.classList.remove('is-loading')
    if (btn.dataset.origHtml !== undefined) {
      btn.innerHTML = btn.dataset.origHtml
      delete btn.dataset.origHtml
      delete btn.dataset.origText
    }
  }
}

export function updateButtonLoadingLabel(btn, loadingText) {
  if (!btn) return
  const lbl = btn.querySelector('.btn-loading-label')
  if (lbl) {
    lbl.textContent = loadingText
  }
}

export function createElapsedTimer(onTick) {
  const startedAt = Date.now()
  let stopped = false
  const emit = () => {
    if (stopped) return
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
    onTick(`${sec}s`)
  }
  emit()
  const timerId = setInterval(emit, 200)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timerId)
  }
}

export async function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const payload = String(content ?? '')
  if (window.orca && window.orca.files && typeof window.orca.files.saveAs === 'function') {
    try {
      const res = await window.orca.files.saveAs({
        suggestedName: filename,
        mimeType,
        data: payload,
      })
      return res && res.status === 'cancelled' ? 'cancelled' : 'saved'
    } catch {
      // Fall back to Blob download below
    }
  }
  try {
    const blob = new Blob([payload], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return 'saved'
  } catch {
    return 'failed'
  }
}

export function bindCtrlWheelHorizontalScroll(el) {
  if (!el) return
  el.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!raw) return
      e.preventDefault()
      const step = e.deltaMode === 1 ? raw * 28 : e.deltaMode === 2 ? raw * 320 : raw * 1.25
      el.scrollLeft += step
    },
    { passive: false }
  )
}

export function createEnvBadge(colorTag) {
  if (!colorTag || colorTag === 'none') return null
  const span = document.createElement('span')
  span.className = `badge badge-env-${colorTag}`
  span.textContent = colorTag.toUpperCase()
  return span
}

export function createSortSvg(direction) {
  const ns = 'http://www.w3.org/2000/svg'
  const make = (tag, attrs) => {
    const el = typeof document.createElementNS === 'function'
      ? document.createElementNS(ns, tag)
      : document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v)
    }
    return el
  }
  const svg = make('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(make('line', { x1: '12', y1: '5', x2: '12', y2: '19' }))
  svg.appendChild(
    make('polyline', {
      points: direction === 'ASC' ? '6 11 12 5 18 11' : '6 13 12 19 18 13',
    })
  )
  return svg
}

export function getFolderSvgMarkup(isOpen = false, size = 13) {
  const s = Number.isFinite(Number(size)) ? Math.max(10, Math.min(32, Math.round(Number(size)))) : 13
  if (isOpen) {
    return `<svg class="folder-svg is-open" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg>`
  }
  return `<svg class="folder-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>`
}

export function getWorkspaceSvgMarkup(size = 13) {
  const s = Number.isFinite(Number(size)) ? Math.max(10, Math.min(32, Math.round(Number(size)))) : 13
  return `<svg class="workspace-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`
}

export function syncSelectTooltip(selectEl, customPrefix) {
  if (!selectEl) return
  const prefix =
    customPrefix ||
    selectEl.dataset?.tooltipPrefix ||
    selectEl.getAttribute('aria-label') ||
    'Selected option'
  if (selectEl.dataset && customPrefix) {
    selectEl.dataset.tooltipPrefix = customPrefix
  }
  const selectedOpt =
    selectEl.options && selectEl.selectedIndex >= 0
      ? selectEl.options[selectEl.selectedIndex]
      : null
  const valText = (selectedOpt?.getAttribute('data-full-title') || selectedOpt?.textContent || selectEl.value || '').trim()
  const fullTooltip = valText ? `${prefix}: ${valText}` : prefix
  selectEl.title = fullTooltip
  if (selectEl._customDropdownSync) {
    selectEl._customDropdownSync()
  }
}

export function bindSelectTooltipsInRoot(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return
  const selects = root.querySelectorAll('select')
  selects.forEach((sel) => {
    syncSelectTooltip(sel)
    if (!sel.dataset?.tooltipBound) {
      if (sel.dataset) sel.dataset.tooltipBound = '1'
      sel.addEventListener('change', () => syncSelectTooltip(sel))
      sel.addEventListener('mouseenter', () => syncSelectTooltip(sel))
    }
  })
}

let activeCustomDropdownClose = null

export function isCustomDropdownOpen() {
  return typeof activeCustomDropdownClose === 'function'
}

export function closeActiveCustomDropdown() {
  if (typeof activeCustomDropdownClose === 'function') {
    activeCustomDropdownClose()
    activeCustomDropdownClose = null
  }
}

/**
 * Enhances a native <select> with a rich custom dropdown trigger & floating popover
 * supporting collapsible folders, instant search, expand/collapse all, and full hover tooltips,
 * while keeping the underlying <select> 100% synchronized.
 */
export function enhanceCollapsibleSelectDropdown(selectEl, options = {}) {
  if (!selectEl || !selectEl.parentElement) return null
  if (selectEl._customDropdownApi) {
    selectEl._customDropdownApi.refresh()
    return selectEl._customDropdownApi
  }

  const {
    tooltipPrefix = selectEl.getAttribute('aria-label') || 'Select',
    searchPlaceholder = 'Search...',
    collapsedFolders = new Set(),
    defaultCollapseNonActiveFolders = false,
    onFolderToggle = null,
    leadingIconType = 'none', // 'none' | 'workspace' | 'db'
  } = options

  selectEl.classList.add('sr-only-select')
  const triggerBtn = document.createElement('button')
  triggerBtn.type = 'button'
  triggerBtn.className = 'custom-select-trigger'
  triggerBtn.setAttribute('aria-haspopup', 'listbox')
  triggerBtn.setAttribute('aria-expanded', 'false')

  const leadIconSpan = document.createElement('span')
  leadIconSpan.className = 'custom-select-lead-icon'
  leadIconSpan.hidden = leadingIconType === 'none'

  const labelSpan = document.createElement('span')
  labelSpan.className = 'custom-select-label'

  const chevSpan = document.createElement('span')
  chevSpan.className = 'custom-select-chev'
  chevSpan.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>'

  triggerBtn.append(leadIconSpan, labelSpan, chevSpan)
  selectEl.parentElement.insertBefore(triggerBtn, selectEl.nextSibling)

  let popoverEl = null
  let searchQuery = ''
  let initializedDefaults = false
  let focusTimer = null
  let scrollCloseHandler = null

  function extractStructuredModel() {
    const topItems = []
    const groups = []
    const children = Array.from(selectEl.children || [])
    for (const child of children) {
      if (child.tagName === 'OPTGROUP') {
        const rawLabel = (child.getAttribute('label') || 'Folder').trim()
        const folderName = rawLabel || 'Folder'
        const opts = Array.from(child.querySelectorAll('option')).map((o) => ({
          value: o.value,
          label: (o.textContent || '').trim(),
          driver: o.dataset?.driver || '',
          subtitle: o.dataset?.subtitle || '',
          fullTitle: o.dataset?.fullTitle || (o.textContent || '').trim(),
          isCurrent: o.dataset?.isCurrent === '1',
          disabled: Boolean(o.disabled),
        }))
        if (opts.length > 0) {
          groups.push({ folderName, items: opts })
        }
      } else if (child.tagName === 'OPTION') {
        topItems.push({
          value: child.value,
          label: (child.textContent || '').trim(),
          driver: child.dataset?.driver || '',
          subtitle: child.dataset?.subtitle || '',
          fullTitle: child.dataset?.fullTitle || (child.textContent || '').trim(),
          isCurrent: child.dataset?.isCurrent === '1',
          disabled: Boolean(child.disabled),
        })
      }
    }
    return { topItems, groups }
  }

  function syncTriggerDisplay() {
    const selectedOpt =
      selectEl.options && selectEl.selectedIndex >= 0
        ? selectEl.options[selectEl.selectedIndex]
        : null
    const cleanText = (selectedOpt?.textContent || '').trim()
    labelSpan.textContent = cleanText || 'Select...'
    const fullDetail = (
      selectedOpt?.dataset?.fullTitle ||
      cleanText ||
      'None'
    ).trim()
    const fullTip = `${tooltipPrefix}: ${fullDetail}`
    triggerBtn.title = fullTip
    selectEl.title = fullTip
    triggerBtn.disabled = Boolean(selectEl.disabled)

    if (leadingIconType === 'workspace') {
      leadIconSpan.hidden = false
      leadIconSpan.innerHTML = getWorkspaceSvgMarkup(12)
    } else if (leadingIconType === 'db' && selectedOpt?.dataset?.driver) {
      leadIconSpan.hidden = false
      leadIconSpan.innerHTML = getDbLogoSvg(selectedOpt.dataset.driver, 13)
    } else {
      leadIconSpan.hidden = true
    }
  }

  function closePopover() {
    if (focusTimer !== null) {
      clearTimeout(focusTimer)
      focusTimer = null
    }
    if (scrollCloseHandler) {
      document.removeEventListener('scroll', scrollCloseHandler, true)
      scrollCloseHandler = null
    }
    if (popoverEl) {
      popoverEl.remove()
      popoverEl = null
    }
    triggerBtn.setAttribute('aria-expanded', 'false')
    if (activeCustomDropdownClose === closePopover) {
      activeCustomDropdownClose = null
    }
  }

  function selectValue(val) {
    if (selectEl.value !== val) {
      selectEl.value = val
      selectEl.dispatchEvent(new Event('change', { bubbles: true }))
    }
    syncTriggerDisplay()
    closePopover()
  }

  function openPopover() {
    if (selectEl.disabled) return
    if (popoverEl) {
      closePopover()
      return
    }
    closeActiveCustomDropdown()
    activeCustomDropdownClose = closePopover
    searchQuery = ''

    const model = extractStructuredModel()
    if (defaultCollapseNonActiveFolders && !initializedDefaults && model.groups.length > 1) {
      initializedDefaults = true
      const currentVal = selectEl.value
      for (const grp of model.groups) {
        const hasSelected = grp.items.some((i) => i.value === currentVal || i.isCurrent)
        if (!hasSelected) {
          collapsedFolders.add(grp.folderName)
        }
      }
    }

    popoverEl = document.createElement('div')
    popoverEl.className = 'custom-select-popover'
    popoverEl.setAttribute('role', 'listbox')

    const headerRow = document.createElement('div')
    headerRow.className = 'custom-select-head'

    const searchInp = document.createElement('input')
    searchInp.type = 'search'
    searchInp.className = 'input custom-select-search'
    searchInp.placeholder = searchPlaceholder
    searchInp.value = searchQuery
    headerRow.appendChild(searchInp)

    if (model.groups.length > 0) {
      const expandBtn = document.createElement('button')
      expandBtn.type = 'button'
      expandBtn.className = 'btn btn-ghost btn-icon btn-sm'
      expandBtn.title = 'Expand all folders in dropdown'
      expandBtn.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg>'
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        collapsedFolders.clear()
        if (typeof onFolderToggle === 'function') onFolderToggle(collapsedFolders)
        renderList()
      })

      const collapseBtn = document.createElement('button')
      collapseBtn.type = 'button'
      collapseBtn.className = 'btn btn-ghost btn-icon btn-sm'
      collapseBtn.title = 'Collapse all folders in dropdown'
      collapseBtn.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline></svg>'
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        for (const g of model.groups) collapsedFolders.add(g.folderName)
        if (typeof onFolderToggle === 'function') onFolderToggle(collapsedFolders)
        renderList()
      })
      headerRow.append(expandBtn, collapseBtn)
    }

    const listBox = document.createElement('div')
    listBox.className = 'custom-select-list'
    popoverEl.append(headerRow, listBox)

    function createOptionRow(item, indented = false) {
      const btn = document.createElement('button')
      btn.type = 'button'
      const isSelected = item.value === selectEl.value
      btn.className = `custom-select-item${isSelected ? ' active' : ''}${indented ? ' is-indented' : ''}`
      btn.disabled = item.disabled
      btn.title = item.fullTitle || item.label

      if (item.driver) {
        const ico = document.createElement('span')
        ico.className = 'custom-select-item-icon'
        ico.innerHTML = getDbLogoSvg(item.driver, 13)
        btn.appendChild(ico)
      } else if (leadingIconType === 'workspace') {
        const ico = document.createElement('span')
        ico.className = 'custom-select-item-icon'
        ico.innerHTML = getWorkspaceSvgMarkup(12)
        btn.appendChild(ico)
      }

      const txtWrap = document.createElement('div')
      txtWrap.className = 'custom-select-item-text'
      const mainLbl = document.createElement('span')
      mainLbl.className = 'custom-select-item-label'
      mainLbl.textContent = item.label
      txtWrap.appendChild(mainLbl)
      if (item.subtitle) {
        const subLbl = document.createElement('span')
        subLbl.className = 'custom-select-item-sub'
        subLbl.textContent = item.subtitle
        txtWrap.appendChild(subLbl)
      }
      btn.appendChild(txtWrap)

      if (isSelected) {
        const chk = document.createElement('span')
        chk.className = 'custom-select-item-check'
        chk.textContent = '✓'
        btn.appendChild(chk)
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        selectValue(item.value)
      })
      return btn
    }

    function renderList() {
      listBox.textContent = ''
      const q = searchQuery.trim().toLowerCase()
      let matchCount = 0

      for (const item of model.topItems) {
        const matches =
          !q ||
          item.label.toLowerCase().includes(q) ||
          (item.fullTitle && item.fullTitle.toLowerCase().includes(q))
        if (!matches) continue
        matchCount++
        listBox.appendChild(createOptionRow(item, false))
      }

      for (const grp of model.groups) {
        const folderMatches = !q || grp.folderName.toLowerCase().includes(q)
        const matchingItems = grp.items.filter(
          (i) =>
            !q ||
            folderMatches ||
            i.label.toLowerCase().includes(q) ||
            (i.fullTitle && i.fullTitle.toLowerCase().includes(q)) ||
            (i.subtitle && i.subtitle.toLowerCase().includes(q))
        )
        if (matchingItems.length === 0) continue
        matchCount += matchingItems.length

        const isCollapsed = !q && collapsedFolders.has(grp.folderName)
        const grpHead = document.createElement('button')
        grpHead.type = 'button'
        grpHead.className = `custom-select-folder-head${isCollapsed ? ' is-collapsed' : ''}`
        grpHead.title = `${isCollapsed ? 'Expand' : 'Collapse'} folder "${grp.folderName}" (${matchingItems.length})`

        const chev = document.createElement('span')
        chev.className = `tree-chevron${isCollapsed ? '' : ' open'}`
        chev.innerHTML =
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>'

        const fIcon = document.createElement('span')
        fIcon.className = 'custom-select-folder-icon'
        fIcon.innerHTML = getFolderSvgMarkup(!isCollapsed, 13)

        const fName = document.createElement('span')
        fName.className = 'custom-select-folder-name'
        fName.textContent = grp.folderName

        const fCount = document.createElement('span')
        fCount.className = 'custom-select-folder-count'
        fCount.textContent = String(matchingItems.length)

        grpHead.append(chev, fIcon, fName, fCount)
        grpHead.addEventListener('click', (e) => {
          e.stopPropagation()
          if (collapsedFolders.has(grp.folderName)) {
            collapsedFolders.delete(grp.folderName)
          } else {
            collapsedFolders.add(grp.folderName)
          }
          if (typeof onFolderToggle === 'function') onFolderToggle(collapsedFolders)
          renderList()
        })
        listBox.appendChild(grpHead)

        if (!isCollapsed) {
          for (const item of matchingItems) {
            listBox.appendChild(createOptionRow(item, true))
          }
        }
      }

      if (matchCount === 0) {
        const emptyEl = document.createElement('div')
        emptyEl.className = 'custom-select-empty'
        emptyEl.textContent = q ? `No matches for "${searchQuery}"` : 'No options available'
        listBox.appendChild(emptyEl)
      }
    }

    searchInp.addEventListener('input', () => {
      searchQuery = searchInp.value
      renderList()
    })
    searchInp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closePopover()
        triggerBtn.focus()
      }
    })

    renderList()
    document.body.appendChild(popoverEl)
    triggerBtn.setAttribute('aria-expanded', 'true')

    const rect = triggerBtn.getBoundingClientRect()
    const vw = window.innerWidth || 360
    const vh = window.innerHeight || 640
    const desiredWidth = Math.max(rect.width, 250)
    const width = Math.min(desiredWidth, vw - 12)
    const left = Math.max(6, Math.min(rect.left, vw - width - 6))
    popoverEl.style.width = `${width}px`
    popoverEl.style.left = `${left}px`

    const spaceBelow = vh - rect.bottom - 8
    const spaceAbove = rect.top - 8
    if (spaceBelow < 180 && spaceAbove > spaceBelow) {
      const maxH = Math.max(140, Math.min(320, spaceAbove))
      popoverEl.style.maxHeight = `${maxH}px`
      popoverEl.style.top = 'auto'
      popoverEl.style.bottom = `${Math.max(6, Math.round(vh - rect.top + 4))}px`
    } else {
      const maxH = Math.max(140, Math.min(320, spaceBelow))
      popoverEl.style.maxHeight = `${maxH}px`
      popoverEl.style.bottom = 'auto'
      popoverEl.style.top = `${Math.round(rect.bottom + 4)}px`
    }

    scrollCloseHandler = (ev) => {
      if (
        popoverEl &&
        ev.target &&
        (ev.target === popoverEl || (ev.target instanceof Node && popoverEl.contains(ev.target)))
      ) {
        return
      }
      closePopover()
    }
    document.addEventListener('scroll', scrollCloseHandler, true)

    focusTimer = setTimeout(() => {
      focusTimer = null
      if (popoverEl && (model.groups.length > 0 || model.topItems.length > 4)) {
        searchInp.focus()
      }
    }, 10)
  }

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openPopover()
  })

  selectEl.addEventListener('change', () => {
    syncTriggerDisplay()
  })

  selectEl._customDropdownSync = syncTriggerDisplay
  const api = {
    refresh: () => {
      syncTriggerDisplay()
      if (popoverEl) {
        closePopover()
      }
    },
    close: closePopover,
    triggerBtn,
  }
  selectEl._customDropdownApi = api
  syncTriggerDisplay()
  return api
}

export function $(id) {
  return document.getElementById(id)
}

export async function writeTextToClipboard(text) {
  const val = String(text ?? '')
  let copied = false
  try {
    const prevActive =
      typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const ta = document.createElement('textarea')
    ta.value = val
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    try {
      ta.focus({ preventScroll: true })
    } catch {
      ta.focus()
    }
    ta.select()
    try {
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, val.length)
      }
    } catch {}
    try {
      copied = Boolean(document.execCommand('copy'))
    } catch {}
    ta.remove()
    if (prevActive && typeof prevActive.focus === 'function') {
      try {
        prevActive.focus({ preventScroll: true })
      } catch {
        prevActive.focus()
      }
    }
  } catch {}

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(val)
      copied = true
    } catch {}
  }

  return copied
}

export function syncVirtualTableWindow({
  virt,
  total,
  start,
  end,
  rowHeightPx,
  createRow,
  selectionController,
  onBeforeDetachRow,
  force = false,
}) {
  if (!force && start === virt.start && end === virt.end) {
    return false
  }

  const { tbody, topSpacerTr, topSpacerTd, bottomSpacerTr, bottomSpacerTd } = virt
  const topPx = start * rowHeightPx
  const bottomPx = Math.max(0, (total - end) * rowHeightPx)
  if (topSpacerTr && topSpacerTd) {
    topSpacerTr.style.display = topPx > 0 ? '' : 'none'
    topSpacerTd.style.height = `${topPx}px`
  }
  if (bottomSpacerTr && bottomSpacerTd) {
    bottomSpacerTr.style.display = bottomPx > 0 ? '' : 'none'
    bottomSpacerTd.style.height = `${bottomPx}px`
  }

  const isDomEl = (node) =>
    typeof HTMLElement !== 'undefined'
      ? node instanceof HTMLElement
      : Boolean(node && node.nodeType === 1)

  const prevStart = virt.start
  const prevEnd = virt.end
  const canReuse =
    !force && prevStart >= 0 && prevEnd > prevStart && start < prevEnd && end > prevStart

  if (!canReuse) {
    let node = topSpacerTr ? topSpacerTr.nextSibling : tbody.firstChild
    while (node && node !== bottomSpacerTr) {
      const next = node.nextSibling
      if (isDomEl(node)) {
        onBeforeDetachRow?.(node)
        selectionController?.detachRow(node)
      }
      node.remove()
      node = next
    }
    const frag = document.createDocumentFragment()
    for (let r = start; r < end; r++) {
      frag.appendChild(createRow(r))
    }
    tbody.insertBefore(frag, bottomSpacerTr)
  } else {
    let node = topSpacerTr ? topSpacerTr.nextSibling : tbody.firstChild
    while (node && node !== bottomSpacerTr) {
      const next = node.nextSibling
      if (isDomEl(node) && node.dataset?.rowIdx !== undefined) {
        const ri = Number(node.dataset.rowIdx)
        if (ri < start || ri >= end) {
          onBeforeDetachRow?.(node)
          selectionController?.detachRow(node)
          node.remove()
        }
      }
      node = next
    }
    if (start < prevStart) {
      const topFrag = document.createDocumentFragment()
      const upper = Math.min(prevStart, end)
      for (let r = start; r < upper; r++) {
        topFrag.appendChild(createRow(r))
      }
      const insertRef = topSpacerTr ? topSpacerTr.nextSibling : tbody.firstChild
      tbody.insertBefore(topFrag, insertRef)
    }
    if (end > prevEnd) {
      const botFrag = document.createDocumentFragment()
      const lower = Math.max(prevEnd, start)
      for (let r = lower; r < end; r++) {
        botFrag.appendChild(createRow(r))
      }
      tbody.insertBefore(botFrag, bottomSpacerTr)
    }
  }

  virt.start = start
  virt.end = end
  if (force) {
    selectionController?.applyDomClasses()
  }
  return true
}

const PANEL_PICKER_CLASSES = {
  overlay: 'modal-backdrop panel-fp-backdrop',
  modal: 'modal-card panel-fp-card',
  head: 'panel-fp-head',
  title: 'panel-fp-title',
  roots: 'panel-fp-roots',
  root: 'panel-fp-root',
  nav: 'panel-fp-nav',
  upBtn: 'btn btn-sm panel-fp-up',
  pathInput: 'input panel-fp-path',
  filterInput: 'input',
  list: 'panel-fp-list',
  row: 'panel-fp-row',
  icon: 'panel-fp-icon',
  name: 'panel-fp-name',
  meta: 'panel-fp-meta',
  empty: 'panel-fp-empty',
  status: 'panel-fp-status',
  foot: 'panel-fp-foot',
  selected: 'panel-fp-selected',
  actions: 'panel-fp-actions',
  btnSm: 'btn btn-sm',
  btnPrimarySm: 'btn btn-primary btn-sm',
}

export function openPanelFilePickerModal(options) {
  return openSharedFilePickerModal({
    title: options?.title,
    mode: options?.mode,
    initialDir: options?.initialDir,
    extensions: options?.extensions,
    maxRoots: 8,
    classes: PANEL_PICKER_CLASSES,
    listDir: (input) => rpc('fs.listDir', input),
  })
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (!activeCustomDropdownClose) return
    const tgt = e.target
    if (
      tgt instanceof Element &&
      (tgt.closest('.custom-select-popover') || tgt.closest('.custom-select-trigger'))
    ) {
      return
    }
    closeActiveCustomDropdown()
  })
}
