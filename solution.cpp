#include <bits/stdc++.h>
using namespace std;

#pragma GCC optimize("O3,unroll-loops")

typedef long long ll;
typedef unsigned long long ull;
typedef __int128_t i128;

using pii = pair<int, int>;
using pll = pair<ll, ll>;

constexpr int MOD = 1'000'000'007;

struct AC {
    vector<array<int, 26>> ch;
    vector<int> fail;
    vector<vector<int>> pats, g;
    int tot = 0;

    AC() { new_node(); }

    int new_node() {
        ch.push_back({});
        ch.back().fill(0);
        fail.push_back(0);
        pats.push_back({});
        return tot++;
    }

    int insert(const string &s, int pid) {
        int u = 0;
        for (char c : s) {
            int x = c - 'a';
            if (!ch[u][x]) ch[u][x] = new_node();
            u = ch[u][x];
        }
        pats[u].push_back(pid);
        return u;
    }

    void build() {
        queue<int> q;
        for (int c = 0; c < 26; c++) {
            if (ch[0][c]) {
                fail[ch[0][c]] = 0;
                q.push(ch[0][c]);
            }
        }
        while (!q.empty()) {
            int u = q.front();
            q.pop();
            for (int c = 0; c < 26; c++) {
                int v = ch[u][c];
                if (v) {
                    fail[v] = ch[fail[u]][c];
                    q.push(v);
                } else {
                    ch[u][c] = ch[fail[u]][c];
                }
            }
        }
        g.assign(tot, {});
        for (int i = 1; i < tot; i++) g[fail[i]].push_back(i);
    }
};

int kmp_count(const string &pat, const string &text) {
    int m = (int)pat.size(), n = (int)text.size();
    if (m > n) return 0;
    vector<int> nxt(m);
    for (int i = 1, j = 0; i < m; i++) {
        while (j && pat[i] != pat[j]) j = nxt[j - 1];
        if (pat[i] == pat[j]) ++j;
        nxt[i] = j;
    }
    int cnt = 0;
    for (int i = 0, j = 0; i < n; i++) {
        while (j && text[i] != pat[j]) j = nxt[j - 1];
        if (text[i] == pat[j]) ++j;
        if (j == m) {
            ++cnt;
            j = nxt[j - 1];
        }
    }
    return cnt;
}

void solve_all_a(int n, int q, const vector<int> &len) {
    vector<int> ql(q), qr(q), qL(q), qR(q);
    for (int i = 0; i < q; i++) cin >> ql[i] >> qr[i] >> qL[i] >> qR[i];

    vector<int> vals(len.begin() + 1, len.end());
    sort(vals.begin(), vals.end());
    vals.erase(unique(vals.begin(), vals.end()), vals.end());
    int D = (int)vals.size();
    int maxL = vals.back();
    vector<int> id(maxL + 1, -1);
    for (int t = 0; t < D; t++) id[vals[t]] = t;

    // pref row-major by index for query-friendly access: cell(j, t)
    vector<int> pref((size_t)(n + 1) * D, 0);
    auto cell = [&](int j, int t) -> int & { return pref[(size_t)j * D + t]; };
    for (int j = 1; j <= n; j++) cell(j, id[len[j]])++;
    for (int j = 1; j <= n; j++)
        for (int t = 0; t < D; t++) cell(j, t) += cell(j - 1, t);

    vector<int> ct(D);
    vector<ll> sufCnt(D + 1), sufSum(D + 1);

    for (int qi = 0; qi < q; qi++) {
        int l = ql[qi], r = qr[qi], L = qL[qi], R = qR[qi];
        for (int t = 0; t < D; t++) ct[t] = cell(R, t) - cell(L - 1, t);
        sufCnt[D] = sufSum[D] = 0;
        for (int t = D - 1; t >= 0; t--) {
            sufCnt[t] = sufCnt[t + 1] + ct[t];
            sufSum[t] = sufSum[t + 1] + 1LL * vals[t] * ct[t];
        }
        ll ans = 0;
        for (int t = 0; t < D; t++) {
            int cp = cell(r, t) - cell(l - 1, t);
            if (!cp) continue;
            int need = vals[t] - 1;
            int u = (int)(lower_bound(vals.begin(), vals.end(), need) - vals.begin());
            ll g = sufSum[u] - 1LL * need * sufCnt[u];
            ans += g * cp;
        }
        cout << ans << '\n';
    }
}

void solve() {
    int n, q;
    cin >> n >> q;

    vector<string> s(n + 1);
    int msum = 0;
    bool all_a = true;
    for (int i = 1; i <= n; i++) {
        cin >> s[i];
        msum += (int)s[i].size();
        if (all_a) {
            for (char c : s[i])
                if (c != 'a') {
                    all_a = false;
                    break;
                }
        }
    }

    if (all_a) {
        vector<int> len(n + 1);
        for (int i = 1; i <= n; i++) len[i] = (int)s[i].size();
        s.clear();
        s.shrink_to_fit();
        solve_all_a(n, q, len);
        return;
    }

    const int B = max(40, (int)sqrt((double)max(msum, 1)));

    vector<int> ql(q), qr(q), qL(q), qR(q);
    for (int i = 0; i < q; i++) cin >> ql[i] >> qr[i] >> qL[i] >> qR[i];
    vector<ll> ans(q, 0);

    vector<char> is_short(n + 1, 0);
    vector<int> short_list;
    for (int i = 1; i <= n; i++) {
        if ((int)s[i].size() <= B) {
            is_short[i] = 1;
            short_list.push_back(i);
        }
    }

    // Long patterns via KMP
    for (int i = 1; i <= n; i++) {
        if (is_short[i]) continue;
        vector<ll> pref(n + 1);
        for (int j = 1; j <= n; j++) pref[j] = pref[j - 1] + kmp_count(s[i], s[j]);
        for (int qi = 0; qi < q; qi++)
            if (ql[qi] <= i && i <= qr[qi]) ans[qi] += pref[qR[qi]] - pref[qL[qi] - 1];
    }

    if (short_list.empty()) {
        for (int i = 0; i < q; i++) cout << ans[i] << '\n';
        return;
    }

    // Short patterns: hot nodes O(q) + cold fenwick sweep for F(x,y)
    AC ac;
    vector<int> endn(n + 1, 0);
    for (int i : short_list) endn[i] = ac.insert(s[i], i);
    ac.build();

    vector<char> is_end(ac.tot, 0);
    for (int i : short_list) is_end[endn[i]] = 1;

    vector<int> output(ac.tot, 0);
    {
        queue<int> qq;
        vector<char> vis(ac.tot, 0);
        qq.push(0);
        vis[0] = 1;
        while (!qq.empty()) {
            int u = qq.front();
            qq.pop();
            if (u) output[u] = is_end[ac.fail[u]] ? ac.fail[u] : output[ac.fail[u]];
            for (int v : ac.g[u])
                if (!vis[v]) {
                    vis[v] = 1;
                    qq.push(v);
                }
        }
    }

    vector<vector<int>> pats(ac.tot), occ(ac.tot);
    for (int i : short_list) pats[endn[i]].push_back(i);
    for (int j = 1; j <= n; j++) {
        int u = 0;
        for (char c : s[j]) {
            u = ac.ch[u][c - 'a'];
            int p = is_end[u] ? u : output[u];
            while (p) {
                occ[p].push_back(j);
                p = output[p];
            }
        }
    }

    vector<char> is_hot(ac.tot, 0);
    {
        const int MAX_HOT = 150;
        const ll COST_BUDGET = 80000000LL; // keep residual fenwick updates modest
        vector<pair<ll, int>> scores;
        scores.reserve(ac.tot);
        ll total = 0;
        for (int u = 1; u < ac.tot; u++) {
            if (pats[u].empty() || occ[u].empty()) continue;
            ll sc = 1LL * (int)pats[u].size() * (int)occ[u].size();
            scores.push_back({sc, u});
            total += sc;
        }
        sort(scores.begin(), scores.end(), greater<pair<ll, int>>());
        ll residual = total;
        int taken = 0;
        for (auto [sc, u] : scores) {
            if (taken >= MAX_HOT) break;
            if (residual <= COST_BUDGET && sc < 100000) break;
            is_hot[u] = 1;
            residual -= sc;
            taken++;

            vector<int> prefP(n + 1, 0), prefT(n + 1, 0);
            for (int i : pats[u]) prefP[i]++;
            for (int i = 1; i <= n; i++) prefP[i] += prefP[i - 1];
            for (int t : occ[u]) prefT[t]++;
            for (int j = 1; j <= n; j++) prefT[j] += prefT[j - 1];
            for (int qi = 0; qi < q; qi++) {
                int a = prefP[qr[qi]] - prefP[ql[qi] - 1];
                int b = prefT[qR[qi]] - prefT[qL[qi] - 1];
                ans[qi] += 1LL * a * b;
            }
        }
    }

    // F(x,y) = sum_{i=1..x, i cold short} (#occ of s_i in texts 1..y)
    // query contrib = F(r,R)-F(r,L-1)-F(l-1,R)+F(l-1,L-1)
    struct BIT {
        int n;
        vector<ll> t;
        BIT(int n = 0) : n(n), t(n + 1, 0) {}
        void add(int i, ll v) {
            for (; i <= n; i += i & -i) t[i] += v;
        }
        ll sum(int i) const {
            ll r = 0;
            for (; i > 0; i -= i & -i) r += t[i];
            return r;
        }
    };

    struct Corner {
        int x, sign, qi;
    };
    vector<vector<Corner>> ev(n + 1);
    for (int qi = 0; qi < q; qi++) {
        int l = ql[qi], r = qr[qi], L = qL[qi], R = qR[qi];
        auto push = [&](int x, int y, int sign) {
            if (x <= 0 || y <= 0) return;
            ev[y].push_back({x, sign, qi});
        };
        push(r, R, +1);
        push(r, L - 1, -1);
        push(l - 1, R, -1);
        push(l - 1, L - 1, +1);
    }

    BIT fw(n);
    for (int y = 1; y <= n; y++) {
        int u = 0;
        for (char c : s[y]) {
            u = ac.ch[u][c - 'a'];
            int p = is_end[u] ? u : output[u];
            while (p) {
                if (!is_hot[p]) {
                    for (int i : pats[p]) fw.add(i, 1);
                }
                p = output[p];
            }
        }
        for (auto [x, sign, qi] : ev[y]) ans[qi] += (ll)sign * fw.sum(x);
    }

    for (int i = 0; i < q; i++) cout << ans[i] << '\n';
}

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    solve();
    return 0;
}
