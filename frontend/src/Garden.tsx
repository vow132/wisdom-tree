import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, number, type Dialogue, type State } from './api';
import { Button, Dialog, useAction, useNotice } from './ui';
import GameScene from './GameScene';

type TreeAction = 'seed' | 'plant' | 'claim-fertilizer' | 'feed';

export default function Garden({ state, onLogin }: { state: State; onLogin: () => void }) {
  const [feedNonce, setFeedNonce] = useState(0);
  const [reward, setReward] = useState(0);
  const [tip, setTip] = useState('');
  const [dialogue, setDialogue] = useState<Dialogue>();
  const [animationBusy, setAnimationBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [menu, setMenu] = useState(false);
  const actionLock = useRef(false);
  const talkLock = useRef(false);
  const notify = useNotice();
  const treeAction = useAction<TreeAction>(action => api<State>(`/api/tree/${action}`, { method: 'POST', idempotency: true }), undefined, result => {
    const next = result as State;
    if (next.tip) setTip(next.tip);
    if (next.dialogue) setDialogue(next.dialogue);
    if (next.reward && typeof next.reward === 'object' && 'growth' in next.reward) {
      const coins = next.reward.coins ?? 0;
      setReward(coins);
      setFeedNonce(value => value + 1);
      setAnimationBusy(true);
      setFeedback(`长高 ${next.reward.growth ?? 0} 英尺，收获 ${coins} 金币。`);
    } else if (next.reward && typeof next.reward === 'object' && 'fertilizer' in next.reward) {
      setFeedback(`今日肥料已到账：${next.reward.fertilizer ?? 0} 袋。`);
    } else if (next.tree?.planted && !state.tree?.planted) {
      setFeedback('种子已播下。领取肥料，开始第一次照料吧。');
    } else if (next.tree?.seedClaimed && !state.tree?.seedClaimed) {
      setFeedback('种子已领取。现在可以把它种进花盆。');
    }
  });
  const talkAction = useAction<void>(() => api<Dialogue>('/api/tree/talk', { method: 'POST', idempotency: true }), undefined, result => {
    const next = result as Dialogue;
    setDialogue(next); setTip(next.content);
  }, []);
  const perform = (action: TreeAction) => {
    if (actionLock.current || treeAction.isPending || animationBusy || talkAction.isPending) return;
    actionLock.current = true;
    treeAction.mutate(action, { onSettled: () => { actionLock.current = false; } });
  };
  const talk = () => {
    if (talkLock.current || talkAction.isPending || treeAction.isPending || animationBusy || !state.tree?.planted) return;
    talkLock.current = true;
    talkAction.mutate(undefined, { onSettled: () => { talkLock.current = false; } });
  };
  const planted = !!state.tree?.planted;
  const canFeed = planted && (state.user?.fertilizer ?? 0) > 0;
  const remaining = state.daily?.remaining ?? 0;
  const claimable = Math.max(0, Math.min(remaining, state.rules.inventoryLimit - (state.user?.fertilizer ?? 0)));
  const primaryLabel = !state.user ? '登录领取种子' : !state.tree?.seedClaimed ? '领取智慧树种子' : !planted ? '播种到花盆' : '施肥';
  const interact = () => {
    if (!state.user) return onLogin();
    if (!state.tree?.seedClaimed) return perform('seed');
    if (!planted) return perform('plant');
    if (canFeed) return perform('feed');
    notify({ kind: 'info', message: remaining <= 0 ? '肥料用完了，明天再来领取。' : '先领取今日肥料，再给智慧树施肥。' });
  };
  const owner = state.user?.displayName || state.user?.username;
  return <div className="garden-page">
    <div className="page-heading garden-heading"><div><h1>{owner ? `${owner} 的花园` : '智慧树花园'}</h1><p>每天照料一点，让智慧慢慢生长。</p></div><span className="garden-state-label">{planted ? '正在生长' : state.tree?.seedClaimed ? '等待播种' : '从一颗种子开始'}</span></div>
    <div className="garden-layout">
      <section className="garden-stage" aria-label="智慧树花园场景">
        <div className="garden-toolbar"><span>智慧树</span><div><Button variant="quiet" onClick={() => setMenu(true)}>花园菜单</Button><Link className="button secondary" to="/api">模型商店</Link></div></div>
        <GameScene tree={state.tree} fertilizer={state.user?.fertilizer || 0} coins={state.user?.coins || 0} feedNonce={feedNonce} reward={reward} tip={planted ? tip || '点我一下，听一条智慧树语录。' : state.tree?.seedClaimed ? '种子准备好了，把它种进花盆吧。' : '花盆已经准备好了。领取一颗种子，让智慧开始生长。'} busy={treeAction.isPending || talkAction.isPending} onInteract={interact} onTalk={talk} onAnimationBusyChange={setAnimationBusy} readyLabel={primaryLabel} />
        <div className="garden-caption"><span>{planted ? '拖动肥料到树上，或点击施肥；点击树换一句智慧。' : '每个账号拥有一棵智慧树，成长会一直保存。'}</span>{planted && <Button variant="quiet" onClick={talk} pending={talkAction.isPending} disabled={animationBusy || treeAction.isPending}>听下一句</Button>}</div>
        {planted && dialogue && <div className="dialogue-transcript" aria-live="polite"><div><strong>{dialogue.modelDisplayName}</strong><span>{dialogue.total ? `${dialogue.index} / ${dialogue.total}` : '默认回复'}</span></div><p>{dialogue.content}</p></div>}
      </section>
      <aside className="garden-controls" aria-label="智慧树养成操作">
        <h2>{planted ? '照料你的智慧树' : '种下第一棵智慧树'}</h2>
        <p className="garden-intro">{!state.user ? '登录领种子，把空花盆变成你的花园。' : !state.tree?.seedClaimed ? '领取一颗种子，开始这段成长。' : !planted ? '种子已经准备好，只差第一次播种。' : '一袋肥料，一点成长。收获的金币可以用来调用模型。'}</p>
        {state.user && <dl className="garden-values" aria-live="polite" aria-atomic="true"><div><dt>树高</dt><dd data-testid="tree-height">{number(state.tree?.height || 0)}<small>英尺</small></dd></div><div><dt>肥料</dt><dd>{number(state.user.fertilizer)}<small>/ {state.rules.inventoryLimit} 袋</small></dd></div><div><dt>金币</dt><dd>{number(state.user.coins)}<small>可用余额</small></dd></div></dl>}
        <div className="garden-action-group"><Button className="full-width feed-button" onClick={interact} pending={treeAction.isPending && treeAction.variables !== 'claim-fertilizer'} disabled={treeAction.isPending || talkAction.isPending || animationBusy || (!!state.user && planted && !canFeed)}>{animationBusy ? '正在施肥与生长…' : primaryLabel}{planted && <small>+{state.rules.growthPerFeed} 英尺 · +{state.rules.coinsPerFeed} 金币</small>}</Button>
          {state.user && <Button className="full-width" variant="secondary" onClick={() => perform('claim-fertilizer')} pending={treeAction.isPending && treeAction.variables === 'claim-fertilizer'} disabled={treeAction.isPending || talkAction.isPending || animationBusy || !planted || claimable <= 0}>{!planted ? '播种后领取肥料' : remaining <= 0 ? '今日肥料已领完' : claimable <= 0 ? '肥料库存已满' : `领取今日 ${claimable} 袋肥料`}</Button>}
        </div>
        <p className="growth-feedback" role="status">{feedback || (planted && !canFeed ? remaining > 0 ? '领一袋肥料，就能继续长高。' : '今天已照料完毕，明天再来看看。' : planted ? '准备好了，给它喂一袋肥料吧。' : '领取种子后，点击花盆播种。')}</p>
        <div className="daily-supply"><h3>每日补给</h3><p>每日 {state.rules.dailyFertilizer} 袋，最多存 {state.rules.inventoryLimit} 袋。</p><p>北京时间 00:00 更新，未领取的额度不补发。</p>{state.user && <span>今天还可领 <strong>{remaining}</strong> 袋</span>}</div>
        <Link className="garden-api-link" to="/api">用金币连接 Agent<span>查看模型与密钥</span></Link>
      </aside>
    </div>
    {menu && <Dialog title="花园菜单" onClose={() => setMenu(false)}><div className="menu-links"><Button onClick={() => setMenu(false)}>继续照料</Button><Link to="/api" onClick={() => setMenu(false)} className="button secondary">模型商店与 API 密钥</Link><Link to="/account" onClick={() => setMenu(false)} className="button quiet">我的账号</Link></div></Dialog>}
  </div>;
}
