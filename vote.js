/**
 *
 */
const express = require('express')
// const open = require('open')
const cookieParser = require('cookie-parser')
const multer = require('multer')
const fsp = require('fs').promises
const path = require('path')
const svgCaptcha = require('svg-captcha')
const cors = require('cors')
const WebSocket = require('ws')
const http = require('http')
const _ = require('lodash')

const uploader = multer({ dest: __dirname + /uploads/ })

const app = express()
const port = 8081

/**
 * express 返回的 app 就是用来传给 createServer 的
 */
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

/**
 * 投票 id 到 订阅这个投票信息更新的 websocketr 的映射
 */
const voteIdMapWs = {}

wss.on('connection', async (ws, req) => {
  const voteId = req.url.split('/').slice(-1)[0]
  console.log('将会把投票', voteId, '的实时信息发送到客户端')

  const voteInfo = await db.get(
    'SELECT rowid AS id, * FROM votes WHERE id = ?',
    voteId
  )
  if (Date.now() > new Date(voteInfo.deadline).getTime()) {
    ws.close()
  }

  if (voteId in voteIdMapWs) {
    voteIdMapWs[voteId].push(ws)
  } else {
    voteIdMapWs[voteId] = [ws]
  }

  ws.on('close', () => {
    voteIdMapWs[voteId] = voteIdMapWs[voteId].filter(item => item !== ws)
  })
})

/**
 * 延时广播投票信息
 */
const broadcast = _.throttle(
  async function broadcast(voteId) {
    const websockets = voteIdMapWs[voteId] || []
    const votings = await db.all(
      'SELECT votings.rowid AS id, * FROM votings JOIN user ON userId = user.id WHERE voteId = ?',
      voteId
    )

    for (const ws of websockets) {
      ws.send(JSON.stringify(votings))
    }
  },
  2000,
  { leading: false }
)

/**
 *  数据库
 */
let db
const dbPromise = require('./vote-db.js')

dbPromise.then(value => {
  db = value
})

app.locals.pretty = true

app.use((req, res, next) => {
  console.log(req.method, req.url)
  next()
})

/**
 * cors
 */
app.use(
  cors({
    maxAge: 86400,
    origin: 'true',
    credentials: true,
  })
)

/**
 *
 */
app.use(express.static(__dirname + '/build'))
app.use(express.static(__dirname + '/static'))
app.use('/uploads', express.static(__dirname + '/uploads'))
app.use(express.json()) // Content-Type: application/json
app.use(express.urlencoded({ extended: true })) // Content-Type: application/x-www-form-urlencoded
app.use(cookieParser('kljoewijao2i3940e'))

/**
 * session
 */
const sessionStorage = Object.create(null)

app.use(function sessionMW(req, res, next) {
  if (req.cookies.sessionId) {
    req.session = sessionStorage[req.cookies.sessionId]
    if (!req.session) {
      req.session = sessionStorage[req.cookies.sessionId] = {}
    }
  } else {
    const id = Math.random().toString(16).slice(2)

    req.session = sessionStorage[id] = {}
    res.cookie('sessionId', id, {
      maxAge: 8640000,
    })
  }

  next()
})

/**
 * cookie
 */

app.use(async (req, res, next) => {
  console.log(req.cookies, req.signedCookies)

  // 从签名 cookie 中找出该用户的信息且挂在 req 对象上，以便后续的中间件访问
  // user 是一个视图，不是 users 表，这个视图自带 id
  if (req.signedCookies.user) {
    req.user = await db.get(
      'SELECT * FROM user WHERE name = ?',
      req.signedCookies.user
    )
  }

  next()
})

/**
 * 注册页面
 */
app
  .route('/register')
  .post(uploader.single('avatar'), async (req, res, next) => {
    const user = req.body
    const file = req.file

    const targetName = file.path + '-' + file.originalname

    await fsp.rename(file.path, targetName)

    const avatarOnlineUrl = '/uploads/' + path.basename(targetName)

    try {
      await db.run(`INSERT INTO users VALUES (?, ?, ?, ?)`, [
        user.name,
        user.password,
        user.email,
        avatarOnlineUrl,
      ])
      res.json({
        msg: '注册成功',
        code: 0,
      })
    } catch (err) {
      res.status(400).json({
        msg: '注册失败：' + err.toString(),
        code: -1,
      })
    }
  })

/**
 * 用户名冲突检测接口
 * /username-conflict-check?name=jim
 */
app.get('/username-conflict-check', async (req, res, next) => {
  const user = await db.get(
    'SELECT * FROM users WHERE name = ?',
    req.query.name
  )

  if (user) {
    res.json({
      msg: '用户名已被占用',
      code: -1,
    })
  } else {
    res.json({
      msg: '该用户名可用',
      code: 0,
    })
  }
})

/**
 * 获取验证码图片
 */
app.get('/captcha', function (req, res) {
  let captcha = svgCaptcha.create()
  req.session.captcha = captcha.text

  res.type('svg')
  res.status(200).send(captcha.data)
})

/**
 * 登录
 */
app.route('/login').post(async (req, res, next) => {
  console.log('收到登录请求:', req.body)
  const loginInfo = req.body

  // 验证
  // if (loginInfo.captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
  //   res.json({
  //     msg: '验证码错误',
  //     code: -1,
  //   })

  //   return
  // }

  var user = await db.get(
    'SELECT * FROM users WHERE name = ? AND password = ?',
    [loginInfo.name, loginInfo.password]
  )

  if (user) {
    res.cookie('user', user.name, {
      maxAge: 86400000,
      signed: true,
    })
    res.json(user)
  } else {
    res.status(401).json({
      msg: '登录失败，用户名或密码错误',
      code: -1,
    })
  }
})

/**
 * 用户信息
 */
app.get('/userinfo', async (req, res, next) => {
  if (req.user) {
    res.json(req.user)
  } else {
    res.status(401).json({
      msg: '未登录',
      code: -1,
    })
  }
})

/**
 * 由更改密码的id映射到对应的用户
 */
const changePasswordMap = {}

app
  .route('/forgot')
  .get((req, res, next) => {
    // res.render('forgot.pug')
    alert('暂未完成此功能')
  })
  .post(async (req, res, next) => {
    const email = req.body.email
    const user = await db.get('SELECT * FROM users WHERE email = ?', email)

    if (user) {
      //
    }
  })

app
  .route('/change-password/:id')
  .get(async (req, res, next) => {
    if (user) {
      //
      alert('暂未完成此功能')
    } else {
      res.end('link has expired')
    }
  })
  .post(async (req, res, next) => {
    //
    res.end('password changed successfully!')
  })

/**
 * 创建投票
 */
app.post('/vote', async (req, res, next) => {
  if (req.user) {
    /**
     * 大概需要这样的对象
     * {
     *  title,
     *  desc,
     *  userId
     *  deadline,
     *  anonymous,
     *  isMultiple,
     *  options: ['foo', 'bar'],
     * }
     */
    const voteInfo = req.body

    await db.run('INSERT INTO votes VALUES (?, ?, ?, ?, ?, ?, ?)', [
      voteInfo.title,
      voteInfo.desc,
      req.user.id,
      voteInfo.deadline,
      voteInfo.anonymous,
      new Date().toISOString(),
      voteInfo.isMultiple,
    ])

    const vote = await db.get(
      'SELECT rowid AS id, * FROM votes ORDER BY id DESC LIMIT 1'
    )

    for (const option of voteInfo.options) {
      db.run('INSERT INTO options VALUES (?, ?, ?)', [vote.id, option, 0])
    }

    res.json({
      msg: '创建成功',
      code: 0,
      voteId: vote.id,
    })
  } else {
    res.status(401 /* Unauthorized */).json({
      msg: '未登录无法创建投票',
      code: -1,
    })
  }
})

/**
 * 获取 vote 信息
 */
app.get('/vote/:id', async (req, res, next) => {
  const id = req.params.id
  const vote = await db.get('SELECT rowid AS id, * FROM votes WHERE id = ?', id)
  const options = await db.all(
    'SELECT rowid AS id, * FROM options WHERE voteId = ?',
    id
  )
  const votings = await db.all(
    'SELECT votings.rowid AS id, * FROM votings JOIN user ON userId = user.id WHERE voteId = ?',
    id
  )

  vote.options = options
  vote.votings = votings

  res.json(vote)
})

app.get('/myvotes', async (req, res, next) => {
  if (!req.user) {
    res.status(401).json({
      msg: '用户未登录',
      code: -1,
    })
    return
  }

  const myVotes = await db.all(
    'SELECT rowid AS id, * FROM votes WHERE userId = ?',
    req.user.id
  )
  res.json(myVotes)
})

/**
 * 用户对某选项发起投票
 */
app.post('/voteup/:voteId', async (req, res, next) => {
  /**
   * {
   *    optionId: 3,
   *    isVoteDown: true
   * }
   */
  const voteId = req.params.voteId
  const body = req.body
  console.log(voteId, body)
  const vote = await db.get(
    'SELECT rowid AS id, * FROM votes WHERE id = ?',
    voteId
  )

  if (Date.now() > new Date(vote.deadline).getTime()) {
    res.status(401).end({
      msg: '该投票项已经过截止日期，不能再投票',
      code: -1,
    })

    return
  }

  if (!vote.isMultiple) {
    // 单选项
    // 删除之前可能投的一票
    await db.run('DELETE FROM votings WHERE userId = ? AND voteId = ?', [
      req.user.id,
      voteId,
    ])

    // 增加最新的选项
    await db.run('INSERT INTO votings VALUES (?, ?, ?)', [
      voteId,
      body.optionId,
      req.user.id,
    ])
    res.end()
  } else {
    // 多选项
    console.log('支持多选', req.body)
    await db.run(
      'DELETE FROM votings WHERE voteId = ? AND optionId = ? AND userId = ?',
      [voteId, body.optionId, req.user.id]
    )

    if (!req.body.isVoteDown) {
      await db.run('INSERT INTO votings VALUES (?, ?, ?)', [
        voteId,
        body.optionId,
        req.user.id,
      ])
    }
    res.end()
  }
  broadcast(voteId)
})

/**
 * 登出
 */
app.get('/logout', (req, res, next) => {
  res.clearCookie('user')
  res.redirect('/')
})

/**
 * 监听
 */
server.listen(port, () => {
  console.log('server listening on port', port)
  // open('http://loaclhost:' + port)
})
