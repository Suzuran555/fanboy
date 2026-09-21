#!/bin/bash
# Dragon Arena -> 云服务器 一键部署（在 Mac 的“终端”里运行，不是在 Claude 里）
#
#   bash ~/Desktop/battlecode/dragon-arena/deploy-to-lightsail.sh            部署 / 更新
#   bash ~/Desktop/battlecode/dragon-arena/deploy-to-lightsail.sh status     看服务状态和最近日志
#   bash ~/Desktop/battlecode/dragon-arena/deploy-to-lightsail.sh logs       实时日志（Ctrl+C 退出）
#   bash ~/Desktop/battlecode/dragon-arena/deploy-to-lightsail.sh restart    重启游戏服务
#   bash ~/Desktop/battlecode/dragon-arena/deploy-to-lightsail.sh ssh        登录服务器
#
# 可用环境变量覆盖：SERVER=地址  KEY=私钥路径  PORT=端口(默认 auto：80 空闲就用 80，否则 8080)  ACCESS_KEY=口令
# 兼容 macOS 自带的 bash 3.2。

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="${SERVER:-2406:da1c:e62:1f00:e858:86ac:b36a:4782}"
KEY_SRC="${KEY:-$HERE/../LightsailDefaultKey-ap-southeast-2.pem}"
KEY_DST="$HOME/.ssh/$(basename "$KEY_SRC")"
PORT_WANTED="${PORT:-auto}"
ACCESS_KEY="${ACCESS_KEY:-}"
BUNDLE="$HERE/dragon-arena-server.tar.gz"
STATE="$HERE/.arena-server"
ACTION="${1:-deploy}"
LOG="$HERE/deploy-log.txt"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mXX  %s\033[0m\n' "$*"; echo "DEPLOY_RESULT=failed"; exit 1; }

case "$SERVER" in *:*) URL_HOST="[$SERVER]" ;; *) URL_HOST="$SERVER" ;; esac

# ---------------------------------------------------------------- 私钥：复制一份到 ~/.ssh 并收紧权限（ssh 拒绝用权限过宽的私钥）
[ -f "$KEY_SRC" ] || [ -f "$KEY_DST" ] || die "找不到私钥：$KEY_SRC"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ -f "$KEY_SRC" ]; then
  if [ ! -f "$KEY_DST" ] || ! cmp -s "$KEY_SRC" "$KEY_DST"; then cp "$KEY_SRC" "$KEY_DST"; fi
fi
chmod 600 "$KEY_DST"

CFG="$(mktemp /tmp/arena-ssh.XXXXXX)"
trap 'rm -f "$CFG"' EXIT
write_cfg() {   # $1 = 登录用户
  cat > "$CFG" <<CFGEOF
Host arena
  HostName $SERVER
  User $1
  IdentityFile $KEY_DST
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ConnectTimeout 12
  ServerAliveInterval 15
  ServerAliveCountMax 4
  LogLevel ERROR
CFGEOF
}

SSH_USER=""; ARENA_PORT=""
if [ -f "$STATE" ]; then   # 上次部署记下的登录用户，只取字母数字，不直接 source
  SSH_USER="$(awk -F= '$1 == "SSH_USER" { print $2; exit }' "$STATE" | tr -cd 'A-Za-z0-9._-')"
fi

find_user() {
  local u out
  for u in ${SSH_USER:-} ubuntu ec2-user admin debian bitnami rocky almalinux centos fedora root; do
    [ -n "$u" ] || continue
    write_cfg "$u"
    out="$(ssh -F "$CFG" -o BatchMode=yes arena 'echo ARENA_LOGIN_OK' 2>&1)"
    case "$out" in
      *ARENA_LOGIN_OK*) SSH_USER="$u"; return 0 ;;
      *"Permission denied"*|*"Please login as"*) continue ;;
      *) LAST_SSH_ERROR="$out"; return 2 ;;
    esac
  done
  return 1
}

network_help() {
  echo
  warn "连不上 $SERVER 的 22 端口。ssh 的原话：${LAST_SSH_ERROR:-（无）}"
  case "$SERVER" in
    *:*)
      if ifconfig 2>/dev/null | grep -E 'inet6 (2|3)[0-9a-f]{3}:' | grep -vq deprecated; then
        echo "    这台 Mac 有公网 IPv6 地址，所以更可能是：实例还没启动完 / Lightsail 防火墙的 IPv6 规则里没放行 SSH(22)。"
      else
        echo "    这台 Mac 当前的网络【没有 IPv6】，而这台服务器只给了 IPv6 地址，所以根本到不了。三个办法任选："
        echo "      1) 换一个有 IPv6 的网络再跑一次（手机热点通常有；可先打开 https://test-ipv6.com 看得分）。"
        echo "      2) Lightsail 控制台 -> 这台实例 -> Change networking type -> Dual-stack，拿到 IPv4 后："
        echo "           SERVER=新的IPv4地址 bash \"$0\""
        echo "      3) 用 Lightsail 控制台里的浏览器 SSH 登录，手动部署（把 deploy-log.txt 给 Claude 看，它会给你命令）。"
      fi ;;
    *) echo "    检查：实例是否在运行、Lightsail 防火墙是否放行 SSH(22)、地址是否写对。" ;;
  esac
}

connect_or_die() {
  LAST_SSH_ERROR=""
  find_user; rc=$?
  if [ $rc -eq 2 ]; then network_help; die "网络不通，未做任何改动。"; fi
  if [ $rc -ne 0 ]; then die "能连上服务器，但这把私钥登录不了任何常见用户名（ubuntu / ec2-user / admin ...）。确认这台实例创建时选的密钥对就是 $(basename "$KEY_DST")。"; fi
}

# ---------------------------------------------------------------- 小工具子命令
case "$ACTION" in
  ssh)     connect_or_die; ssh -F "$CFG" arena; exit $? ;;
  logs)    connect_or_die; ssh -F "$CFG" -t arena 'sudo journalctl -u dragon-arena -f -n 50'; exit $? ;;
  status)  connect_or_die; ssh -F "$CFG" arena 'systemctl --no-pager --lines=0 status dragon-arena; echo; sudo journalctl -u dragon-arena --no-pager -n 20'; exit $? ;;
  restart) connect_or_die; ssh -F "$CFG" arena 'sudo systemctl restart dragon-arena && sleep 1 && systemctl is-active dragon-arena'; exit $? ;;
  deploy)  ;;
  *)       die "不认识的子命令：$ACTION（可用：deploy / status / logs / restart / ssh）" ;;
esac

# ---------------------------------------------------------------- 部署（所有输出同时写进 deploy-log.txt，方便 Claude 读）
exec > >(tee "$LOG") 2>&1
echo "Dragon Arena 部署  $(date '+%Y-%m-%d %H:%M:%S %Z')   目标：$SERVER"
[ -f "$BUNDLE" ] || die "找不到部署包：$BUNDLE"

say "1/5 连接服务器"
connect_or_die
echo "    登录成功：用户 $SSH_USER"
FACTS="$(ssh -F "$CFG" arena '
  . /etc/os-release 2>/dev/null; echo "OS=${PRETTY_NAME:-unknown}"
  echo "ARCH=$(uname -m)"
  echo "MEM_MB=$(free -m 2>/dev/null | awk "/^Mem:/ {print \$2}")"
  if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then echo SUDO=yes; else echo SUDO=no; fi
  n=no; for c in /usr/bin/node /usr/local/bin/node; do if [ -x $c ] && [ "$($c -p "process.versions.node.split(\".\")[0]" 2>/dev/null || echo 0)" -ge 18 ]; then n="$($c --version)"; fi; done; echo "NODE=$n"
  if curl -fsSI --max-time 8 https://nodejs.org/dist/ >/dev/null 2>&1; then echo NODEJS_ORG=yes; else echo NODEJS_ORG=no; fi
  a=0; command -v apt-cache >/dev/null 2>&1 && a="$(apt-cache policy nodejs 2>/dev/null | awk "/Candidate:/ {print \$2}" | sed "s/^[0-9]*://" | cut -d. -f1)"; echo "APT_NODE=${a:-0}"
  echo "IPV4=$(curl -4 -fsS --max-time 4 https://api.ipify.org 2>/dev/null)"
')"
echo "$FACTS" | sed 's/^/    /'
fact() { echo "$FACTS" | awk -F= -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }'; }
[ "$(fact SUDO)" = yes ] || die "用户 $SSH_USER 没有免密 sudo，没法安装系统服务。"

say "2/5 上传部署包（$(du -h "$BUNDLE" | awk '{print $1}')）"
scp -F "$CFG" -q "$BUNDLE" arena:/tmp/dragon-arena-server.tar.gz || die "上传失败。"

NODE_ENV_ARG=""
APT_NODE="$(fact APT_NODE)"; case "$APT_NODE" in ''|*[!0-9]*) APT_NODE=0 ;; esac
if [ "$(fact NODE)" = no ] && [ "$(fact NODEJS_ORG)" = no ] && [ "$APT_NODE" -lt 18 ]; then
  say "2b  服务器自己下载不了 Node.js，由这台 Mac 代为下载后传过去"
  case "$(fact ARCH)" in x86_64|amd64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; *) die "不支持的 CPU 架构：$(fact ARCH)" ;; esac
  NBASE="https://nodejs.org/dist/latest-v22.x"
  NNAME="$(curl -fsSL --max-time 30 "$NBASE/SHASUMS256.txt" | awk -v a="linux-$NARCH.tar.gz" 'index($2, a) { print $2; exit }')"
  [ -n "$NNAME" ] || die "这台 Mac 也访问不了 nodejs.org。"
  curl -fL --max-time 600 -o "/tmp/$NNAME" "$NBASE/$NNAME" || die "下载 Node.js 失败。"
  WANT="$(curl -fsSL --max-time 30 "$NBASE/SHASUMS256.txt" | awk -v n="$NNAME" '$2 == n { print $1 }')"
  GOT="$(shasum -a 256 "/tmp/$NNAME" | awk '{print $1}')"
  [ "$WANT" = "$GOT" ] || die "Node.js 安装包校验和不对，已中止。"
  scp -F "$CFG" -q "/tmp/$NNAME" arena:/tmp/node-linux.tar.gz || die "上传 Node.js 失败。"
  rm -f "/tmp/$NNAME"
  NODE_ENV_ARG="NODE_TARBALL=/tmp/node-linux.tar.gz"
fi

say "3/5 在服务器上安装（Node.js + systemd 服务，独立低权限用户，沙箱运行）"
ssh -F "$CFG" arena "set -e; rm -rf /tmp/dragon-arena; tar -xzf /tmp/dragon-arena-server.tar.gz -C /tmp; cd /tmp/dragon-arena; sudo env PORT='$PORT_WANTED' ACCESS_KEY='$ACCESS_KEY' $NODE_ENV_ARG bash deploy.sh" | tee /tmp/arena-remote.$$ | sed 's/^/    /'
REMOTE_RC=${PIPESTATUS[0]}
ARENA_PORT="$(awk -F= '/^ARENA_PORT=/ {print $2}' /tmp/arena-remote.$$ | tail -1)"; rm -f /tmp/arena-remote.$$
[ "$REMOTE_RC" -eq 0 ] && [ -n "$ARENA_PORT" ] || die "服务器上的安装脚本失败了（上面有原因）。把这个窗口的内容或 deploy-log.txt 给 Claude 看。"
ssh -F "$CFG" arena 'rm -rf /tmp/dragon-arena /tmp/dragon-arena-server.tar.gz /tmp/node-linux.tar.gz' || true
printf 'SSH_USER=%s\nARENA_PORT=%s\n' "$SSH_USER" "$ARENA_PORT" > "$STATE"

PORT_SUFFIX=":$ARENA_PORT"; [ "$ARENA_PORT" = 80 ] && PORT_SUFFIX=""
KEY_SUFFIX=""; [ -n "$ACCESS_KEY" ] && KEY_SUFFIX="?key=$ACCESS_KEY"
URL="http://$URL_HOST$PORT_SUFFIX/$KEY_SUFFIX"
IPV4="$(fact IPV4)"

say "4/5 从这台 Mac 检查能不能访问"
HEALTH="$(curl -g -s -m 10 "http://$URL_HOST:$ARENA_PORT/healthz" 2>&1)"
WS="$(curl -g -s -m 4 -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' "http://$URL_HOST:$ARENA_PORT/ws" 2>/dev/null | head -1 | tr -d '\r')"
echo "    网页：${HEALTH:-没有响应}      WebSocket：${WS:-没有响应}"
REACHABLE=no
if [ "$HEALTH" = ok ]; then case "$WS" in *101*) REACHABLE=yes ;; esac; fi

say "5/5 结果"
if [ "$REACHABLE" = yes ]; then
  echo "    部署成功，外网可以访问。"
else
  warn "服务已经在服务器上跑起来了，但从外面访问不到端口 $ARENA_PORT —— 多半是 Lightsail 防火墙没放行。"
  echo "    Lightsail 控制台 -> 这台实例 -> Networking -> IPv6 firewall（IPv4 也一样）-> Add rule -> Custom TCP $ARENA_PORT。加完直接刷新网页即可，不用重新部署。"
fi
echo
echo "    游戏地址：  $URL"
[ -n "$IPV4" ] && echo "    IPv4 地址： http://$IPV4$PORT_SUFFIX/$KEY_SUFFIX"
if [ -z "$IPV4" ]; then
  echo "    注意：这台实例没有公网 IPv4。朋友的网络必须有 IPv6 才能连（让他们打开 https://test-ipv6.com 看一下）。"
  echo "          想让所有人都能连：Lightsail 控制台 -> 实例 -> Change networking type -> Dual-stack（套餐价格会变）。"
fi
echo "    看日志：    bash \"$0\" logs          状态： bash \"$0\" status"
echo "    更新版本：  换掉 dragon-arena-server.tar.gz 后再跑一次本脚本"
{
  echo "Dragon Arena 服务器信息（$(date '+%Y-%m-%d %H:%M')）"
  echo "游戏地址: $URL"
  [ -n "$IPV4" ] && echo "IPv4 地址: http://$IPV4$PORT_SUFFIX/$KEY_SUFFIX"
  echo "服务器: $SERVER   登录用户: $SSH_USER   端口: $ARENA_PORT"
  echo "系统: $(fact OS)   内存: $(fact MEM_MB) MB"
  echo "登录: bash \"$0\" ssh     日志: bash \"$0\" logs     重启: bash \"$0\" restart"
} > "$HERE/arena-info.txt"
echo "DEPLOY_RESULT=ok REACHABLE=$REACHABLE URL=$URL"
[ "$REACHABLE" = yes ] && command -v open >/dev/null 2>&1 && open "$URL"
exit 0
