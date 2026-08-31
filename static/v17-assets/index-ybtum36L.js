(function () {
  const a = document.createElement("link").relList;
  if (a && a.supports && a.supports("modulepreload")) return;
  for (const c of document.querySelectorAll('link[rel="modulepreload"]')) l(c);
  new MutationObserver((c) => {
    for (const d of c)
      if (d.type === "childList")
        for (const f of d.addedNodes)
          f.tagName === "LINK" && f.rel === "modulepreload" && l(f);
  }).observe(document, { childList: !0, subtree: !0 });
  function r(c) {
    const d = {};
    return (
      c.integrity && (d.integrity = c.integrity),
      c.referrerPolicy && (d.referrerPolicy = c.referrerPolicy),
      c.crossOrigin === "use-credentials"
        ? (d.credentials = "include")
        : c.crossOrigin === "anonymous"
          ? (d.credentials = "omit")
          : (d.credentials = "same-origin"),
      d
    );
  }
  function l(c) {
    if (c.ep) return;
    c.ep = !0;
    const d = r(c);
    fetch(c.href, d);
  }
})();
var Fu = { exports: {} },
  fs = {};
var fp;
function oS() {
  if (fp) return fs;
  fp = 1;
  var i = Symbol.for("react.transitional.element"),
    a = Symbol.for("react.fragment");
  function r(l, c, d) {
    var f = null;
    if (
      (d !== void 0 && (f = "" + d),
      c.key !== void 0 && (f = "" + c.key),
      "key" in c)
    ) {
      d = {};
      for (var m in c) m !== "key" && (d[m] = c[m]);
    } else d = c;
    return (
      (c = d.ref),
      { $$typeof: i, type: l, key: f, ref: c !== void 0 ? c : null, props: d }
    );
  }
  return (fs.Fragment = a), (fs.jsx = r), (fs.jsxs = r), fs;
}
var dp;
function uS() {
  return dp || ((dp = 1), (Fu.exports = oS())), Fu.exports;
}
var S = uS(),
  $u = { exports: {} },
  ot = {};
var hp;
function cS() {
  if (hp) return ot;
  hp = 1;
  var i = Symbol.for("react.transitional.element"),
    a = Symbol.for("react.portal"),
    r = Symbol.for("react.fragment"),
    l = Symbol.for("react.strict_mode"),
    c = Symbol.for("react.profiler"),
    d = Symbol.for("react.consumer"),
    f = Symbol.for("react.context"),
    m = Symbol.for("react.forward_ref"),
    y = Symbol.for("react.suspense"),
    p = Symbol.for("react.memo"),
    g = Symbol.for("react.lazy"),
    x = Symbol.iterator;
  function b(E) {
    return E === null || typeof E != "object"
      ? null
      : ((E = (x && E[x]) || E["@@iterator"]),
        typeof E == "function" ? E : null);
  }
  var j = {
      isMounted: function () {
        return !1;
      },
      enqueueForceUpdate: function () {},
      enqueueReplaceState: function () {},
      enqueueSetState: function () {},
    },
    A = Object.assign,
    R = {};
  function V(E, q, Q) {
    (this.props = E),
      (this.context = q),
      (this.refs = R),
      (this.updater = Q || j);
  }
  (V.prototype.isReactComponent = {}),
    (V.prototype.setState = function (E, q) {
      if (typeof E != "object" && typeof E != "function" && E != null)
        throw Error(
          "takes an object of state variables to update or a function which returns an object of state variables.",
        );
      this.updater.enqueueSetState(this, E, q, "setState");
    }),
    (V.prototype.forceUpdate = function (E) {
      this.updater.enqueueForceUpdate(this, E, "forceUpdate");
    });
  function L() {}
  L.prototype = V.prototype;
  function _(E, q, Q) {
    (this.props = E),
      (this.context = q),
      (this.refs = R),
      (this.updater = Q || j);
  }
  var H = (_.prototype = new L());
  (H.constructor = _), A(H, V.prototype), (H.isPureReactComponent = !0);
  var X = Array.isArray,
    k = { H: null, A: null, T: null, S: null, V: null },
    tt = Object.prototype.hasOwnProperty;
  function et(E, q, Q, K, nt, gt) {
    return (
      (Q = gt.ref),
      { $$typeof: i, type: E, key: q, ref: Q !== void 0 ? Q : null, props: gt }
    );
  }
  function P(E, q) {
    return et(E.type, q, void 0, void 0, void 0, E.props);
  }
  function lt(E) {
    return typeof E == "object" && E !== null && E.$$typeof === i;
  }
  function W(E) {
    var q = { "=": "=0", ":": "=2" };
    return (
      "$" +
      E.replace(/[=:]/g, function (Q) {
        return q[Q];
      })
    );
  }
  var mt = /\/+/g;
  function pt(E, q) {
    return typeof E == "object" && E !== null && E.key != null
      ? W("" + E.key)
      : q.toString(36);
  }
  function $t() {}
  function Kt(E) {
    switch (E.status) {
      case "fulfilled":
        return E.value;
      case "rejected":
        throw E.reason;
      default:
        switch (
          (typeof E.status == "string"
            ? E.then($t, $t)
            : ((E.status = "pending"),
              E.then(
                function (q) {
                  E.status === "pending" &&
                    ((E.status = "fulfilled"), (E.value = q));
                },
                function (q) {
                  E.status === "pending" &&
                    ((E.status = "rejected"), (E.reason = q));
                },
              )),
          E.status)
        ) {
          case "fulfilled":
            return E.value;
          case "rejected":
            throw E.reason;
        }
    }
    throw E;
  }
  function Ct(E, q, Q, K, nt) {
    var gt = typeof E;
    (gt === "undefined" || gt === "boolean") && (E = null);
    var rt = !1;
    if (E === null) rt = !0;
    else
      switch (gt) {
        case "bigint":
        case "string":
        case "number":
          rt = !0;
          break;
        case "object":
          switch (E.$$typeof) {
            case i:
            case a:
              rt = !0;
              break;
            case g:
              return (rt = E._init), Ct(rt(E._payload), q, Q, K, nt);
          }
      }
    if (rt)
      return (
        (nt = nt(E)),
        (rt = K === "" ? "." + pt(E, 0) : K),
        X(nt)
          ? ((Q = ""),
            rt != null && (Q = rt.replace(mt, "$&/") + "/"),
            Ct(nt, q, Q, "", function (gn) {
              return gn;
            }))
          : nt != null &&
            (lt(nt) &&
              (nt = P(
                nt,
                Q +
                  (nt.key == null || (E && E.key === nt.key)
                    ? ""
                    : ("" + nt.key).replace(mt, "$&/") + "/") +
                  rt,
              )),
            q.push(nt)),
        1
      );
    rt = 0;
    var me = K === "" ? "." : K + ":";
    if (X(E))
      for (var wt = 0; wt < E.length; wt++)
        (K = E[wt]), (gt = me + pt(K, wt)), (rt += Ct(K, q, Q, gt, nt));
    else if (((wt = b(E)), typeof wt == "function"))
      for (E = wt.call(E), wt = 0; !(K = E.next()).done; )
        (K = K.value), (gt = me + pt(K, wt++)), (rt += Ct(K, q, Q, gt, nt));
    else if (gt === "object") {
      if (typeof E.then == "function") return Ct(Kt(E), q, Q, K, nt);
      throw (
        ((q = String(E)),
        Error(
          "Objects are not valid as a React child (found: " +
            (q === "[object Object]"
              ? "object with keys {" + Object.keys(E).join(", ") + "}"
              : q) +
            "). If you meant to render a collection of children, use an array instead.",
        ))
      );
    }
    return rt;
  }
  function z(E, q, Q) {
    if (E == null) return E;
    var K = [],
      nt = 0;
    return (
      Ct(E, K, "", "", function (gt) {
        return q.call(Q, gt, nt++);
      }),
      K
    );
  }
  function Z(E) {
    if (E._status === -1) {
      var q = E._result;
      (q = q()),
        q.then(
          function (Q) {
            (E._status === 0 || E._status === -1) &&
              ((E._status = 1), (E._result = Q));
          },
          function (Q) {
            (E._status === 0 || E._status === -1) &&
              ((E._status = 2), (E._result = Q));
          },
        ),
        E._status === -1 && ((E._status = 0), (E._result = q));
    }
    if (E._status === 1) return E._result.default;
    throw E._result;
  }
  var J =
    typeof reportError == "function"
      ? reportError
      : function (E) {
          if (
            typeof window == "object" &&
            typeof window.ErrorEvent == "function"
          ) {
            var q = new window.ErrorEvent("error", {
              bubbles: !0,
              cancelable: !0,
              message:
                typeof E == "object" &&
                E !== null &&
                typeof E.message == "string"
                  ? String(E.message)
                  : String(E),
              error: E,
            });
            if (!window.dispatchEvent(q)) return;
          } else if (
            typeof process == "object" &&
            typeof process.emit == "function"
          ) {
            process.emit("uncaughtException", E);
            return;
          }
          console.error(E);
        };
  function ut() {}
  return (
    (ot.Children = {
      map: z,
      forEach: function (E, q, Q) {
        z(
          E,
          function () {
            q.apply(this, arguments);
          },
          Q,
        );
      },
      count: function (E) {
        var q = 0;
        return (
          z(E, function () {
            q++;
          }),
          q
        );
      },
      toArray: function (E) {
        return (
          z(E, function (q) {
            return q;
          }) || []
        );
      },
      only: function (E) {
        if (!lt(E))
          throw Error(
            "React.Children.only expected to receive a single React element child.",
          );
        return E;
      },
    }),
    (ot.Component = V),
    (ot.Fragment = r),
    (ot.Profiler = c),
    (ot.PureComponent = _),
    (ot.StrictMode = l),
    (ot.Suspense = y),
    (ot.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = k),
    (ot.__COMPILER_RUNTIME = {
      __proto__: null,
      c: function (E) {
        return k.H.useMemoCache(E);
      },
    }),
    (ot.cache = function (E) {
      return function () {
        return E.apply(null, arguments);
      };
    }),
    (ot.cloneElement = function (E, q, Q) {
      if (E == null)
        throw Error(
          "The argument must be a React element, but you passed " + E + ".",
        );
      var K = A({}, E.props),
        nt = E.key,
        gt = void 0;
      if (q != null)
        for (rt in (q.ref !== void 0 && (gt = void 0),
        q.key !== void 0 && (nt = "" + q.key),
        q))
          !tt.call(q, rt) ||
            rt === "key" ||
            rt === "__self" ||
            rt === "__source" ||
            (rt === "ref" && q.ref === void 0) ||
            (K[rt] = q[rt]);
      var rt = arguments.length - 2;
      if (rt === 1) K.children = Q;
      else if (1 < rt) {
        for (var me = Array(rt), wt = 0; wt < rt; wt++)
          me[wt] = arguments[wt + 2];
        K.children = me;
      }
      return et(E.type, nt, void 0, void 0, gt, K);
    }),
    (ot.createContext = function (E) {
      return (
        (E = {
          $$typeof: f,
          _currentValue: E,
          _currentValue2: E,
          _threadCount: 0,
          Provider: null,
          Consumer: null,
        }),
        (E.Provider = E),
        (E.Consumer = { $$typeof: d, _context: E }),
        E
      );
    }),
    (ot.createElement = function (E, q, Q) {
      var K,
        nt = {},
        gt = null;
      if (q != null)
        for (K in (q.key !== void 0 && (gt = "" + q.key), q))
          tt.call(q, K) &&
            K !== "key" &&
            K !== "__self" &&
            K !== "__source" &&
            (nt[K] = q[K]);
      var rt = arguments.length - 2;
      if (rt === 1) nt.children = Q;
      else if (1 < rt) {
        for (var me = Array(rt), wt = 0; wt < rt; wt++)
          me[wt] = arguments[wt + 2];
        nt.children = me;
      }
      if (E && E.defaultProps)
        for (K in ((rt = E.defaultProps), rt))
          nt[K] === void 0 && (nt[K] = rt[K]);
      return et(E, gt, void 0, void 0, null, nt);
    }),
    (ot.createRef = function () {
      return { current: null };
    }),
    (ot.forwardRef = function (E) {
      return { $$typeof: m, render: E };
    }),
    (ot.isValidElement = lt),
    (ot.lazy = function (E) {
      return { $$typeof: g, _payload: { _status: -1, _result: E }, _init: Z };
    }),
    (ot.memo = function (E, q) {
      return { $$typeof: p, type: E, compare: q === void 0 ? null : q };
    }),
    (ot.startTransition = function (E) {
      var q = k.T,
        Q = {};
      k.T = Q;
      try {
        var K = E(),
          nt = k.S;
        nt !== null && nt(Q, K),
          typeof K == "object" &&
            K !== null &&
            typeof K.then == "function" &&
            K.then(ut, J);
      } catch (gt) {
        J(gt);
      } finally {
        k.T = q;
      }
    }),
    (ot.unstable_useCacheRefresh = function () {
      return k.H.useCacheRefresh();
    }),
    (ot.use = function (E) {
      return k.H.use(E);
    }),
    (ot.useActionState = function (E, q, Q) {
      return k.H.useActionState(E, q, Q);
    }),
    (ot.useCallback = function (E, q) {
      return k.H.useCallback(E, q);
    }),
    (ot.useContext = function (E) {
      return k.H.useContext(E);
    }),
    (ot.useDebugValue = function () {}),
    (ot.useDeferredValue = function (E, q) {
      return k.H.useDeferredValue(E, q);
    }),
    (ot.useEffect = function (E, q, Q) {
      var K = k.H;
      if (typeof Q == "function")
        throw Error(
          "useEffect CRUD overload is not enabled in this build of React.",
        );
      return K.useEffect(E, q);
    }),
    (ot.useId = function () {
      return k.H.useId();
    }),
    (ot.useImperativeHandle = function (E, q, Q) {
      return k.H.useImperativeHandle(E, q, Q);
    }),
    (ot.useInsertionEffect = function (E, q) {
      return k.H.useInsertionEffect(E, q);
    }),
    (ot.useLayoutEffect = function (E, q) {
      return k.H.useLayoutEffect(E, q);
    }),
    (ot.useMemo = function (E, q) {
      return k.H.useMemo(E, q);
    }),
    (ot.useOptimistic = function (E, q) {
      return k.H.useOptimistic(E, q);
    }),
    (ot.useReducer = function (E, q, Q) {
      return k.H.useReducer(E, q, Q);
    }),
    (ot.useRef = function (E) {
      return k.H.useRef(E);
    }),
    (ot.useState = function (E) {
      return k.H.useState(E);
    }),
    (ot.useSyncExternalStore = function (E, q, Q) {
      return k.H.useSyncExternalStore(E, q, Q);
    }),
    (ot.useTransition = function () {
      return k.H.useTransition();
    }),
    (ot.version = "19.1.1"),
    ot
  );
}
var mp;
function Zc() {
  return mp || ((mp = 1), ($u.exports = cS())), $u.exports;
}
var U = Zc(),
  Wu = { exports: {} },
  ds = {},
  Iu = { exports: {} },
  tc = {};
var pp;
function fS() {
  return (
    pp ||
      ((pp = 1),
      (function (i) {
        function a(z, Z) {
          var J = z.length;
          z.push(Z);
          t: for (; 0 < J; ) {
            var ut = (J - 1) >>> 1,
              E = z[ut];
            if (0 < c(E, Z)) (z[ut] = Z), (z[J] = E), (J = ut);
            else break t;
          }
        }
        function r(z) {
          return z.length === 0 ? null : z[0];
        }
        function l(z) {
          if (z.length === 0) return null;
          var Z = z[0],
            J = z.pop();
          if (J !== Z) {
            z[0] = J;
            t: for (var ut = 0, E = z.length, q = E >>> 1; ut < q; ) {
              var Q = 2 * (ut + 1) - 1,
                K = z[Q],
                nt = Q + 1,
                gt = z[nt];
              if (0 > c(K, J))
                nt < E && 0 > c(gt, K)
                  ? ((z[ut] = gt), (z[nt] = J), (ut = nt))
                  : ((z[ut] = K), (z[Q] = J), (ut = Q));
              else if (nt < E && 0 > c(gt, J))
                (z[ut] = gt), (z[nt] = J), (ut = nt);
              else break t;
            }
          }
          return Z;
        }
        function c(z, Z) {
          var J = z.sortIndex - Z.sortIndex;
          return J !== 0 ? J : z.id - Z.id;
        }
        if (
          ((i.unstable_now = void 0),
          typeof performance == "object" &&
            typeof performance.now == "function")
        ) {
          var d = performance;
          i.unstable_now = function () {
            return d.now();
          };
        } else {
          var f = Date,
            m = f.now();
          i.unstable_now = function () {
            return f.now() - m;
          };
        }
        var y = [],
          p = [],
          g = 1,
          x = null,
          b = 3,
          j = !1,
          A = !1,
          R = !1,
          V = !1,
          L = typeof setTimeout == "function" ? setTimeout : null,
          _ = typeof clearTimeout == "function" ? clearTimeout : null,
          H = typeof setImmediate < "u" ? setImmediate : null;
        function X(z) {
          for (var Z = r(p); Z !== null; ) {
            if (Z.callback === null) l(p);
            else if (Z.startTime <= z)
              l(p), (Z.sortIndex = Z.expirationTime), a(y, Z);
            else break;
            Z = r(p);
          }
        }
        function k(z) {
          if (((R = !1), X(z), !A))
            if (r(y) !== null) (A = !0), tt || ((tt = !0), pt());
            else {
              var Z = r(p);
              Z !== null && Ct(k, Z.startTime - z);
            }
        }
        var tt = !1,
          et = -1,
          P = 5,
          lt = -1;
        function W() {
          return V ? !0 : !(i.unstable_now() - lt < P);
        }
        function mt() {
          if (((V = !1), tt)) {
            var z = i.unstable_now();
            lt = z;
            var Z = !0;
            try {
              t: {
                (A = !1), R && ((R = !1), _(et), (et = -1)), (j = !0);
                var J = b;
                try {
                  e: {
                    for (
                      X(z), x = r(y);
                      x !== null && !(x.expirationTime > z && W());
                    ) {
                      var ut = x.callback;
                      if (typeof ut == "function") {
                        (x.callback = null), (b = x.priorityLevel);
                        var E = ut(x.expirationTime <= z);
                        if (((z = i.unstable_now()), typeof E == "function")) {
                          (x.callback = E), X(z), (Z = !0);
                          break e;
                        }
                        x === r(y) && l(y), X(z);
                      } else l(y);
                      x = r(y);
                    }
                    if (x !== null) Z = !0;
                    else {
                      var q = r(p);
                      q !== null && Ct(k, q.startTime - z), (Z = !1);
                    }
                  }
                  break t;
                } finally {
                  (x = null), (b = J), (j = !1);
                }
                Z = void 0;
              }
            } finally {
              Z ? pt() : (tt = !1);
            }
          }
        }
        var pt;
        if (typeof H == "function")
          pt = function () {
            H(mt);
          };
        else if (typeof MessageChannel < "u") {
          var $t = new MessageChannel(),
            Kt = $t.port2;
          ($t.port1.onmessage = mt),
            (pt = function () {
              Kt.postMessage(null);
            });
        } else
          pt = function () {
            L(mt, 0);
          };
        function Ct(z, Z) {
          et = L(function () {
            z(i.unstable_now());
          }, Z);
        }
        (i.unstable_IdlePriority = 5),
          (i.unstable_ImmediatePriority = 1),
          (i.unstable_LowPriority = 4),
          (i.unstable_NormalPriority = 3),
          (i.unstable_Profiling = null),
          (i.unstable_UserBlockingPriority = 2),
          (i.unstable_cancelCallback = function (z) {
            z.callback = null;
          }),
          (i.unstable_forceFrameRate = function (z) {
            0 > z || 125 < z
              ? console.error(
                  "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported",
                )
              : (P = 0 < z ? Math.floor(1e3 / z) : 5);
          }),
          (i.unstable_getCurrentPriorityLevel = function () {
            return b;
          }),
          (i.unstable_next = function (z) {
            switch (b) {
              case 1:
              case 2:
              case 3:
                var Z = 3;
                break;
              default:
                Z = b;
            }
            var J = b;
            b = Z;
            try {
              return z();
            } finally {
              b = J;
            }
          }),
          (i.unstable_requestPaint = function () {
            V = !0;
          }),
          (i.unstable_runWithPriority = function (z, Z) {
            switch (z) {
              case 1:
              case 2:
              case 3:
              case 4:
              case 5:
                break;
              default:
                z = 3;
            }
            var J = b;
            b = z;
            try {
              return Z();
            } finally {
              b = J;
            }
          }),
          (i.unstable_scheduleCallback = function (z, Z, J) {
            var ut = i.unstable_now();
            switch (
              (typeof J == "object" && J !== null
                ? ((J = J.delay),
                  (J = typeof J == "number" && 0 < J ? ut + J : ut))
                : (J = ut),
              z)
            ) {
              case 1:
                var E = -1;
                break;
              case 2:
                E = 250;
                break;
              case 5:
                E = 1073741823;
                break;
              case 4:
                E = 1e4;
                break;
              default:
                E = 5e3;
            }
            return (
              (E = J + E),
              (z = {
                id: g++,
                callback: Z,
                priorityLevel: z,
                startTime: J,
                expirationTime: E,
                sortIndex: -1,
              }),
              J > ut
                ? ((z.sortIndex = J),
                  a(p, z),
                  r(y) === null &&
                    z === r(p) &&
                    (R ? (_(et), (et = -1)) : (R = !0), Ct(k, J - ut)))
                : ((z.sortIndex = E),
                  a(y, z),
                  A || j || ((A = !0), tt || ((tt = !0), pt()))),
              z
            );
          }),
          (i.unstable_shouldYield = W),
          (i.unstable_wrapCallback = function (z) {
            var Z = b;
            return function () {
              var J = b;
              b = Z;
              try {
                return z.apply(this, arguments);
              } finally {
                b = J;
              }
            };
          });
      })(tc)),
    tc
  );
}
var yp;
function dS() {
  return yp || ((yp = 1), (Iu.exports = fS())), Iu.exports;
}
var ec = { exports: {} },
  se = {};
var gp;
function hS() {
  if (gp) return se;
  gp = 1;
  var i = Zc();
  function a(y) {
    var p = "https://react.dev/errors/" + y;
    if (1 < arguments.length) {
      p += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var g = 2; g < arguments.length; g++)
        p += "&args[]=" + encodeURIComponent(arguments[g]);
    }
    return (
      "Minified React error #" +
      y +
      "; visit " +
      p +
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
    );
  }
  function r() {}
  var l = {
      d: {
        f: r,
        r: function () {
          throw Error(a(522));
        },
        D: r,
        C: r,
        L: r,
        m: r,
        X: r,
        S: r,
        M: r,
      },
      p: 0,
      findDOMNode: null,
    },
    c = Symbol.for("react.portal");
  function d(y, p, g) {
    var x =
      3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: c,
      key: x == null ? null : "" + x,
      children: y,
      containerInfo: p,
      implementation: g,
    };
  }
  var f = i.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function m(y, p) {
    if (y === "font") return "";
    if (typeof p == "string") return p === "use-credentials" ? p : "";
  }
  return (
    (se.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = l),
    (se.createPortal = function (y, p) {
      var g =
        2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
      if (!p || (p.nodeType !== 1 && p.nodeType !== 9 && p.nodeType !== 11))
        throw Error(a(299));
      return d(y, p, null, g);
    }),
    (se.flushSync = function (y) {
      var p = f.T,
        g = l.p;
      try {
        if (((f.T = null), (l.p = 2), y)) return y();
      } finally {
        (f.T = p), (l.p = g), l.d.f();
      }
    }),
    (se.preconnect = function (y, p) {
      typeof y == "string" &&
        (p
          ? ((p = p.crossOrigin),
            (p =
              typeof p == "string"
                ? p === "use-credentials"
                  ? p
                  : ""
                : void 0))
          : (p = null),
        l.d.C(y, p));
    }),
    (se.prefetchDNS = function (y) {
      typeof y == "string" && l.d.D(y);
    }),
    (se.preinit = function (y, p) {
      if (typeof y == "string" && p && typeof p.as == "string") {
        var g = p.as,
          x = m(g, p.crossOrigin),
          b = typeof p.integrity == "string" ? p.integrity : void 0,
          j = typeof p.fetchPriority == "string" ? p.fetchPriority : void 0;
        g === "style"
          ? l.d.S(y, typeof p.precedence == "string" ? p.precedence : void 0, {
              crossOrigin: x,
              integrity: b,
              fetchPriority: j,
            })
          : g === "script" &&
            l.d.X(y, {
              crossOrigin: x,
              integrity: b,
              fetchPriority: j,
              nonce: typeof p.nonce == "string" ? p.nonce : void 0,
            });
      }
    }),
    (se.preinitModule = function (y, p) {
      if (typeof y == "string")
        if (typeof p == "object" && p !== null) {
          if (p.as == null || p.as === "script") {
            var g = m(p.as, p.crossOrigin);
            l.d.M(y, {
              crossOrigin: g,
              integrity: typeof p.integrity == "string" ? p.integrity : void 0,
              nonce: typeof p.nonce == "string" ? p.nonce : void 0,
            });
          }
        } else p == null && l.d.M(y);
    }),
    (se.preload = function (y, p) {
      if (
        typeof y == "string" &&
        typeof p == "object" &&
        p !== null &&
        typeof p.as == "string"
      ) {
        var g = p.as,
          x = m(g, p.crossOrigin);
        l.d.L(y, g, {
          crossOrigin: x,
          integrity: typeof p.integrity == "string" ? p.integrity : void 0,
          nonce: typeof p.nonce == "string" ? p.nonce : void 0,
          type: typeof p.type == "string" ? p.type : void 0,
          fetchPriority:
            typeof p.fetchPriority == "string" ? p.fetchPriority : void 0,
          referrerPolicy:
            typeof p.referrerPolicy == "string" ? p.referrerPolicy : void 0,
          imageSrcSet:
            typeof p.imageSrcSet == "string" ? p.imageSrcSet : void 0,
          imageSizes: typeof p.imageSizes == "string" ? p.imageSizes : void 0,
          media: typeof p.media == "string" ? p.media : void 0,
        });
      }
    }),
    (se.preloadModule = function (y, p) {
      if (typeof y == "string")
        if (p) {
          var g = m(p.as, p.crossOrigin);
          l.d.m(y, {
            as: typeof p.as == "string" && p.as !== "script" ? p.as : void 0,
            crossOrigin: g,
            integrity: typeof p.integrity == "string" ? p.integrity : void 0,
          });
        } else l.d.m(y);
    }),
    (se.requestFormReset = function (y) {
      l.d.r(y);
    }),
    (se.unstable_batchedUpdates = function (y, p) {
      return y(p);
    }),
    (se.useFormState = function (y, p, g) {
      return f.H.useFormState(y, p, g);
    }),
    (se.useFormStatus = function () {
      return f.H.useHostTransitionStatus();
    }),
    (se.version = "19.1.1"),
    se
  );
}
var vp;
function mS() {
  if (vp) return ec.exports;
  vp = 1;
  function i() {
    if (
      !(
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" ||
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"
      )
    )
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(i);
      } catch (a) {
        console.error(a);
      }
  }
  return i(), (ec.exports = hS()), ec.exports;
}
var Sp;
function pS() {
  if (Sp) return ds;
  Sp = 1;
  var i = dS(),
    a = Zc(),
    r = mS();
  function l(t) {
    var e = "https://react.dev/errors/" + t;
    if (1 < arguments.length) {
      e += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var n = 2; n < arguments.length; n++)
        e += "&args[]=" + encodeURIComponent(arguments[n]);
    }
    return (
      "Minified React error #" +
      t +
      "; visit " +
      e +
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
    );
  }
  function c(t) {
    return !(!t || (t.nodeType !== 1 && t.nodeType !== 9 && t.nodeType !== 11));
  }
  function d(t) {
    var e = t,
      n = t;
    if (t.alternate) for (; e.return; ) e = e.return;
    else {
      t = e;
      do (e = t), (e.flags & 4098) !== 0 && (n = e.return), (t = e.return);
      while (t);
    }
    return e.tag === 3 ? n : null;
  }
  function f(t) {
    if (t.tag === 13) {
      var e = t.memoizedState;
      if (
        (e === null && ((t = t.alternate), t !== null && (e = t.memoizedState)),
        e !== null)
      )
        return e.dehydrated;
    }
    return null;
  }
  function m(t) {
    if (d(t) !== t) throw Error(l(188));
  }
  function y(t) {
    var e = t.alternate;
    if (!e) {
      if (((e = d(t)), e === null)) throw Error(l(188));
      return e !== t ? null : t;
    }
    for (var n = t, s = e; ; ) {
      var o = n.return;
      if (o === null) break;
      var u = o.alternate;
      if (u === null) {
        if (((s = o.return), s !== null)) {
          n = s;
          continue;
        }
        break;
      }
      if (o.child === u.child) {
        for (u = o.child; u; ) {
          if (u === n) return m(o), t;
          if (u === s) return m(o), e;
          u = u.sibling;
        }
        throw Error(l(188));
      }
      if (n.return !== s.return) (n = o), (s = u);
      else {
        for (var h = !1, v = o.child; v; ) {
          if (v === n) {
            (h = !0), (n = o), (s = u);
            break;
          }
          if (v === s) {
            (h = !0), (s = o), (n = u);
            break;
          }
          v = v.sibling;
        }
        if (!h) {
          for (v = u.child; v; ) {
            if (v === n) {
              (h = !0), (n = u), (s = o);
              break;
            }
            if (v === s) {
              (h = !0), (s = u), (n = o);
              break;
            }
            v = v.sibling;
          }
          if (!h) throw Error(l(189));
        }
      }
      if (n.alternate !== s) throw Error(l(190));
    }
    if (n.tag !== 3) throw Error(l(188));
    return n.stateNode.current === n ? t : e;
  }
  function p(t) {
    var e = t.tag;
    if (e === 5 || e === 26 || e === 27 || e === 6) return t;
    for (t = t.child; t !== null; ) {
      if (((e = p(t)), e !== null)) return e;
      t = t.sibling;
    }
    return null;
  }
  var g = Object.assign,
    x = Symbol.for("react.element"),
    b = Symbol.for("react.transitional.element"),
    j = Symbol.for("react.portal"),
    A = Symbol.for("react.fragment"),
    R = Symbol.for("react.strict_mode"),
    V = Symbol.for("react.profiler"),
    L = Symbol.for("react.provider"),
    _ = Symbol.for("react.consumer"),
    H = Symbol.for("react.context"),
    X = Symbol.for("react.forward_ref"),
    k = Symbol.for("react.suspense"),
    tt = Symbol.for("react.suspense_list"),
    et = Symbol.for("react.memo"),
    P = Symbol.for("react.lazy"),
    lt = Symbol.for("react.activity"),
    W = Symbol.for("react.memo_cache_sentinel"),
    mt = Symbol.iterator;
  function pt(t) {
    return t === null || typeof t != "object"
      ? null
      : ((t = (mt && t[mt]) || t["@@iterator"]),
        typeof t == "function" ? t : null);
  }
  var $t = Symbol.for("react.client.reference");
  function Kt(t) {
    if (t == null) return null;
    if (typeof t == "function")
      return t.$$typeof === $t ? null : t.displayName || t.name || null;
    if (typeof t == "string") return t;
    switch (t) {
      case A:
        return "Fragment";
      case V:
        return "Profiler";
      case R:
        return "StrictMode";
      case k:
        return "Suspense";
      case tt:
        return "SuspenseList";
      case lt:
        return "Activity";
    }
    if (typeof t == "object")
      switch (t.$$typeof) {
        case j:
          return "Portal";
        case H:
          return (t.displayName || "Context") + ".Provider";
        case _:
          return (t._context.displayName || "Context") + ".Consumer";
        case X:
          var e = t.render;
          return (
            (t = t.displayName),
            t ||
              ((t = e.displayName || e.name || ""),
              (t = t !== "" ? "ForwardRef(" + t + ")" : "ForwardRef")),
            t
          );
        case et:
          return (
            (e = t.displayName || null), e !== null ? e : Kt(t.type) || "Memo"
          );
        case P:
          (e = t._payload), (t = t._init);
          try {
            return Kt(t(e));
          } catch {}
      }
    return null;
  }
  var Ct = Array.isArray,
    z = a.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    Z = r.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    J = { pending: !1, data: null, method: null, action: null },
    ut = [],
    E = -1;
  function q(t) {
    return { current: t };
  }
  function Q(t) {
    0 > E || ((t.current = ut[E]), (ut[E] = null), E--);
  }
  function K(t, e) {
    E++, (ut[E] = t.current), (t.current = e);
  }
  var nt = q(null),
    gt = q(null),
    rt = q(null),
    me = q(null);
  function wt(t, e) {
    switch ((K(rt, e), K(gt, t), K(nt, null), e.nodeType)) {
      case 9:
      case 11:
        t = (t = e.documentElement) && (t = t.namespaceURI) ? Hm(t) : 0;
        break;
      default:
        if (((t = e.tagName), (e = e.namespaceURI)))
          (e = Hm(e)), (t = Gm(e, t));
        else
          switch (t) {
            case "svg":
              t = 1;
              break;
            case "math":
              t = 2;
              break;
            default:
              t = 0;
          }
    }
    Q(nt), K(nt, t);
  }
  function gn() {
    Q(nt), Q(gt), Q(rt);
  }
  function _r(t) {
    t.memoizedState !== null && K(me, t);
    var e = nt.current,
      n = Gm(e, t.type);
    e !== n && (K(gt, t), K(nt, n));
  }
  function zs(t) {
    gt.current === t && (Q(nt), Q(gt)),
      me.current === t && (Q(me), (ls._currentValue = J));
  }
  var Lr = Object.prototype.hasOwnProperty,
    zr = i.unstable_scheduleCallback,
    Ur = i.unstable_cancelCallback,
    G0 = i.unstable_shouldYield,
    Y0 = i.unstable_requestPaint,
    qe = i.unstable_now,
    q0 = i.unstable_getCurrentPriorityLevel,
    Sf = i.unstable_ImmediatePriority,
    xf = i.unstable_UserBlockingPriority,
    Us = i.unstable_NormalPriority,
    X0 = i.unstable_LowPriority,
    bf = i.unstable_IdlePriority,
    k0 = i.log,
    Z0 = i.unstable_setDisableYieldValue,
    ma = null,
    pe = null;
  function vn(t) {
    if (
      (typeof k0 == "function" && Z0(t),
      pe && typeof pe.setStrictMode == "function")
    )
      try {
        pe.setStrictMode(ma, t);
      } catch {}
  }
  var ye = Math.clz32 ? Math.clz32 : Q0,
    K0 = Math.log,
    P0 = Math.LN2;
  function Q0(t) {
    return (t >>>= 0), t === 0 ? 32 : (31 - ((K0(t) / P0) | 0)) | 0;
  }
  var Bs = 256,
    Hs = 4194304;
  function Zn(t) {
    var e = t & 42;
    if (e !== 0) return e;
    switch (t & -t) {
      case 1:
        return 1;
      case 2:
        return 2;
      case 4:
        return 4;
      case 8:
        return 8;
      case 16:
        return 16;
      case 32:
        return 32;
      case 64:
        return 64;
      case 128:
        return 128;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return t & 4194048;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return t & 62914560;
      case 67108864:
        return 67108864;
      case 134217728:
        return 134217728;
      case 268435456:
        return 268435456;
      case 536870912:
        return 536870912;
      case 1073741824:
        return 0;
      default:
        return t;
    }
  }
  function Gs(t, e, n) {
    var s = t.pendingLanes;
    if (s === 0) return 0;
    var o = 0,
      u = t.suspendedLanes,
      h = t.pingedLanes;
    t = t.warmLanes;
    var v = s & 134217727;
    return (
      v !== 0
        ? ((s = v & ~u),
          s !== 0
            ? (o = Zn(s))
            : ((h &= v),
              h !== 0
                ? (o = Zn(h))
                : n || ((n = v & ~t), n !== 0 && (o = Zn(n)))))
        : ((v = s & ~u),
          v !== 0
            ? (o = Zn(v))
            : h !== 0
              ? (o = Zn(h))
              : n || ((n = s & ~t), n !== 0 && (o = Zn(n)))),
      o === 0
        ? 0
        : e !== 0 &&
            e !== o &&
            (e & u) === 0 &&
            ((u = o & -o),
            (n = e & -e),
            u >= n || (u === 32 && (n & 4194048) !== 0))
          ? e
          : o
    );
  }
  function pa(t, e) {
    return (t.pendingLanes & ~(t.suspendedLanes & ~t.pingedLanes) & e) === 0;
  }
  function J0(t, e) {
    switch (t) {
      case 1:
      case 2:
      case 4:
      case 8:
      case 64:
        return e + 250;
      case 16:
      case 32:
      case 128:
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return e + 5e3;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return -1;
      case 67108864:
      case 134217728:
      case 268435456:
      case 536870912:
      case 1073741824:
        return -1;
      default:
        return -1;
    }
  }
  function Tf() {
    var t = Bs;
    return (Bs <<= 1), (Bs & 4194048) === 0 && (Bs = 256), t;
  }
  function Ef() {
    var t = Hs;
    return (Hs <<= 1), (Hs & 62914560) === 0 && (Hs = 4194304), t;
  }
  function Br(t) {
    for (var e = [], n = 0; 31 > n; n++) e.push(t);
    return e;
  }
  function ya(t, e) {
    (t.pendingLanes |= e),
      e !== 268435456 &&
        ((t.suspendedLanes = 0), (t.pingedLanes = 0), (t.warmLanes = 0));
  }
  function F0(t, e, n, s, o, u) {
    var h = t.pendingLanes;
    (t.pendingLanes = n),
      (t.suspendedLanes = 0),
      (t.pingedLanes = 0),
      (t.warmLanes = 0),
      (t.expiredLanes &= n),
      (t.entangledLanes &= n),
      (t.errorRecoveryDisabledLanes &= n),
      (t.shellSuspendCounter = 0);
    var v = t.entanglements,
      T = t.expirationTimes,
      C = t.hiddenUpdates;
    for (n = h & ~n; 0 < n; ) {
      var B = 31 - ye(n),
        Y = 1 << B;
      (v[B] = 0), (T[B] = -1);
      var N = C[B];
      if (N !== null)
        for (C[B] = null, B = 0; B < N.length; B++) {
          var w = N[B];
          w !== null && (w.lane &= -536870913);
        }
      n &= ~Y;
    }
    s !== 0 && Af(t, s, 0),
      u !== 0 && o === 0 && t.tag !== 0 && (t.suspendedLanes |= u & ~(h & ~e));
  }
  function Af(t, e, n) {
    (t.pendingLanes |= e), (t.suspendedLanes &= ~e);
    var s = 31 - ye(e);
    (t.entangledLanes |= e),
      (t.entanglements[s] = t.entanglements[s] | 1073741824 | (n & 4194090));
  }
  function Mf(t, e) {
    var n = (t.entangledLanes |= e);
    for (t = t.entanglements; n; ) {
      var s = 31 - ye(n),
        o = 1 << s;
      (o & e) | (t[s] & e) && (t[s] |= e), (n &= ~o);
    }
  }
  function Hr(t) {
    switch (t) {
      case 2:
        t = 1;
        break;
      case 8:
        t = 4;
        break;
      case 32:
        t = 16;
        break;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        t = 128;
        break;
      case 268435456:
        t = 134217728;
        break;
      default:
        t = 0;
    }
    return t;
  }
  function Gr(t) {
    return (
      (t &= -t),
      2 < t ? (8 < t ? ((t & 134217727) !== 0 ? 32 : 268435456) : 8) : 2
    );
  }
  function Rf() {
    var t = Z.p;
    return t !== 0 ? t : ((t = window.event), t === void 0 ? 32 : sp(t.type));
  }
  function $0(t, e) {
    var n = Z.p;
    try {
      return (Z.p = t), e();
    } finally {
      Z.p = n;
    }
  }
  var Sn = Math.random().toString(36).slice(2),
    ie = "__reactFiber$" + Sn,
    ue = "__reactProps$" + Sn,
    vi = "__reactContainer$" + Sn,
    Yr = "__reactEvents$" + Sn,
    W0 = "__reactListeners$" + Sn,
    I0 = "__reactHandles$" + Sn,
    Df = "__reactResources$" + Sn,
    ga = "__reactMarker$" + Sn;
  function qr(t) {
    delete t[ie], delete t[ue], delete t[Yr], delete t[W0], delete t[I0];
  }
  function Si(t) {
    var e = t[ie];
    if (e) return e;
    for (var n = t.parentNode; n; ) {
      if ((e = n[vi] || n[ie])) {
        if (
          ((n = e.alternate),
          e.child !== null || (n !== null && n.child !== null))
        )
          for (t = km(t); t !== null; ) {
            if ((n = t[ie])) return n;
            t = km(t);
          }
        return e;
      }
      (t = n), (n = t.parentNode);
    }
    return null;
  }
  function xi(t) {
    if ((t = t[ie] || t[vi])) {
      var e = t.tag;
      if (e === 5 || e === 6 || e === 13 || e === 26 || e === 27 || e === 3)
        return t;
    }
    return null;
  }
  function va(t) {
    var e = t.tag;
    if (e === 5 || e === 26 || e === 27 || e === 6) return t.stateNode;
    throw Error(l(33));
  }
  function bi(t) {
    var e = t[Df];
    return (
      e ||
        (e = t[Df] =
          { hoistableStyles: new Map(), hoistableScripts: new Map() }),
      e
    );
  }
  function Pt(t) {
    t[ga] = !0;
  }
  var Of = new Set(),
    Cf = {};
  function Kn(t, e) {
    Ti(t, e), Ti(t + "Capture", e);
  }
  function Ti(t, e) {
    for (Cf[t] = e, t = 0; t < e.length; t++) Of.add(e[t]);
  }
  var tv = RegExp(
      "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$",
    ),
    jf = {},
    Nf = {};
  function ev(t) {
    return Lr.call(Nf, t)
      ? !0
      : Lr.call(jf, t)
        ? !1
        : tv.test(t)
          ? (Nf[t] = !0)
          : ((jf[t] = !0), !1);
  }
  function Ys(t, e, n) {
    if (ev(e))
      if (n === null) t.removeAttribute(e);
      else {
        switch (typeof n) {
          case "undefined":
          case "function":
          case "symbol":
            t.removeAttribute(e);
            return;
          case "boolean":
            var s = e.toLowerCase().slice(0, 5);
            if (s !== "data-" && s !== "aria-") {
              t.removeAttribute(e);
              return;
            }
        }
        t.setAttribute(e, "" + n);
      }
  }
  function qs(t, e, n) {
    if (n === null) t.removeAttribute(e);
    else {
      switch (typeof n) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          t.removeAttribute(e);
          return;
      }
      t.setAttribute(e, "" + n);
    }
  }
  function We(t, e, n, s) {
    if (s === null) t.removeAttribute(n);
    else {
      switch (typeof s) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          t.removeAttribute(n);
          return;
      }
      t.setAttributeNS(e, n, "" + s);
    }
  }
  var Xr, wf;
  function Ei(t) {
    if (Xr === void 0)
      try {
        throw Error();
      } catch (n) {
        var e = n.stack.trim().match(/\n( *(at )?)/);
        (Xr = (e && e[1]) || ""),
          (wf =
            -1 <
            n.stack.indexOf(`
    at`)
              ? " (<anonymous>)"
              : -1 < n.stack.indexOf("@")
                ? "@unknown:0:0"
                : "");
      }
    return (
      `
` +
      Xr +
      t +
      wf
    );
  }
  var kr = !1;
  function Zr(t, e) {
    if (!t || kr) return "";
    kr = !0;
    var n = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var s = {
        DetermineComponentFrameRoot: function () {
          try {
            if (e) {
              var Y = function () {
                throw Error();
              };
              if (
                (Object.defineProperty(Y.prototype, "props", {
                  set: function () {
                    throw Error();
                  },
                }),
                typeof Reflect == "object" && Reflect.construct)
              ) {
                try {
                  Reflect.construct(Y, []);
                } catch (w) {
                  var N = w;
                }
                Reflect.construct(t, [], Y);
              } else {
                try {
                  Y.call();
                } catch (w) {
                  N = w;
                }
                t.call(Y.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (w) {
                N = w;
              }
              (Y = t()) &&
                typeof Y.catch == "function" &&
                Y.catch(function () {});
            }
          } catch (w) {
            if (w && N && typeof w.stack == "string") return [w.stack, N.stack];
          }
          return [null, null];
        },
      };
      s.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var o = Object.getOwnPropertyDescriptor(
        s.DetermineComponentFrameRoot,
        "name",
      );
      o &&
        o.configurable &&
        Object.defineProperty(s.DetermineComponentFrameRoot, "name", {
          value: "DetermineComponentFrameRoot",
        });
      var u = s.DetermineComponentFrameRoot(),
        h = u[0],
        v = u[1];
      if (h && v) {
        var T = h.split(`
`),
          C = v.split(`
`);
        for (
          o = s = 0;
          s < T.length && !T[s].includes("DetermineComponentFrameRoot");
        )
          s++;
        for (; o < C.length && !C[o].includes("DetermineComponentFrameRoot"); )
          o++;
        if (s === T.length || o === C.length)
          for (
            s = T.length - 1, o = C.length - 1;
            1 <= s && 0 <= o && T[s] !== C[o];
          )
            o--;
        for (; 1 <= s && 0 <= o; s--, o--)
          if (T[s] !== C[o]) {
            if (s !== 1 || o !== 1)
              do
                if ((s--, o--, 0 > o || T[s] !== C[o])) {
                  var B =
                    `
` + T[s].replace(" at new ", " at ");
                  return (
                    t.displayName &&
                      B.includes("<anonymous>") &&
                      (B = B.replace("<anonymous>", t.displayName)),
                    B
                  );
                }
              while (1 <= s && 0 <= o);
            break;
          }
      }
    } finally {
      (kr = !1), (Error.prepareStackTrace = n);
    }
    return (n = t ? t.displayName || t.name : "") ? Ei(n) : "";
  }
  function nv(t) {
    switch (t.tag) {
      case 26:
      case 27:
      case 5:
        return Ei(t.type);
      case 16:
        return Ei("Lazy");
      case 13:
        return Ei("Suspense");
      case 19:
        return Ei("SuspenseList");
      case 0:
      case 15:
        return Zr(t.type, !1);
      case 11:
        return Zr(t.type.render, !1);
      case 1:
        return Zr(t.type, !0);
      case 31:
        return Ei("Activity");
      default:
        return "";
    }
  }
  function Vf(t) {
    try {
      var e = "";
      do (e += nv(t)), (t = t.return);
      while (t);
      return e;
    } catch (n) {
      return (
        `
Error generating stack: ` +
        n.message +
        `
` +
        n.stack
      );
    }
  }
  function Me(t) {
    switch (typeof t) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "undefined":
        return t;
      case "object":
        return t;
      default:
        return "";
    }
  }
  function _f(t) {
    var e = t.type;
    return (
      (t = t.nodeName) &&
      t.toLowerCase() === "input" &&
      (e === "checkbox" || e === "radio")
    );
  }
  function iv(t) {
    var e = _f(t) ? "checked" : "value",
      n = Object.getOwnPropertyDescriptor(t.constructor.prototype, e),
      s = "" + t[e];
    if (
      !t.hasOwnProperty(e) &&
      typeof n < "u" &&
      typeof n.get == "function" &&
      typeof n.set == "function"
    ) {
      var o = n.get,
        u = n.set;
      return (
        Object.defineProperty(t, e, {
          configurable: !0,
          get: function () {
            return o.call(this);
          },
          set: function (h) {
            (s = "" + h), u.call(this, h);
          },
        }),
        Object.defineProperty(t, e, { enumerable: n.enumerable }),
        {
          getValue: function () {
            return s;
          },
          setValue: function (h) {
            s = "" + h;
          },
          stopTracking: function () {
            (t._valueTracker = null), delete t[e];
          },
        }
      );
    }
  }
  function Xs(t) {
    t._valueTracker || (t._valueTracker = iv(t));
  }
  function Lf(t) {
    if (!t) return !1;
    var e = t._valueTracker;
    if (!e) return !0;
    var n = e.getValue(),
      s = "";
    return (
      t && (s = _f(t) ? (t.checked ? "true" : "false") : t.value),
      (t = s),
      t !== n ? (e.setValue(t), !0) : !1
    );
  }
  function ks(t) {
    if (
      ((t = t || (typeof document < "u" ? document : void 0)), typeof t > "u")
    )
      return null;
    try {
      return t.activeElement || t.body;
    } catch {
      return t.body;
    }
  }
  var av = /[\n"\\]/g;
  function Re(t) {
    return t.replace(av, function (e) {
      return "\\" + e.charCodeAt(0).toString(16) + " ";
    });
  }
  function Kr(t, e, n, s, o, u, h, v) {
    (t.name = ""),
      h != null &&
      typeof h != "function" &&
      typeof h != "symbol" &&
      typeof h != "boolean"
        ? (t.type = h)
        : t.removeAttribute("type"),
      e != null
        ? h === "number"
          ? ((e === 0 && t.value === "") || t.value != e) &&
            (t.value = "" + Me(e))
          : t.value !== "" + Me(e) && (t.value = "" + Me(e))
        : (h !== "submit" && h !== "reset") || t.removeAttribute("value"),
      e != null
        ? Pr(t, h, Me(e))
        : n != null
          ? Pr(t, h, Me(n))
          : s != null && t.removeAttribute("value"),
      o == null && u != null && (t.defaultChecked = !!u),
      o != null &&
        (t.checked = o && typeof o != "function" && typeof o != "symbol"),
      v != null &&
      typeof v != "function" &&
      typeof v != "symbol" &&
      typeof v != "boolean"
        ? (t.name = "" + Me(v))
        : t.removeAttribute("name");
  }
  function zf(t, e, n, s, o, u, h, v) {
    if (
      (u != null &&
        typeof u != "function" &&
        typeof u != "symbol" &&
        typeof u != "boolean" &&
        (t.type = u),
      e != null || n != null)
    ) {
      if (!((u !== "submit" && u !== "reset") || e != null)) return;
      (n = n != null ? "" + Me(n) : ""),
        (e = e != null ? "" + Me(e) : n),
        v || e === t.value || (t.value = e),
        (t.defaultValue = e);
    }
    (s = s ?? o),
      (s = typeof s != "function" && typeof s != "symbol" && !!s),
      (t.checked = v ? t.checked : !!s),
      (t.defaultChecked = !!s),
      h != null &&
        typeof h != "function" &&
        typeof h != "symbol" &&
        typeof h != "boolean" &&
        (t.name = h);
  }
  function Pr(t, e, n) {
    (e === "number" && ks(t.ownerDocument) === t) ||
      t.defaultValue === "" + n ||
      (t.defaultValue = "" + n);
  }
  function Ai(t, e, n, s) {
    if (((t = t.options), e)) {
      e = {};
      for (var o = 0; o < n.length; o++) e["$" + n[o]] = !0;
      for (n = 0; n < t.length; n++)
        (o = e.hasOwnProperty("$" + t[n].value)),
          t[n].selected !== o && (t[n].selected = o),
          o && s && (t[n].defaultSelected = !0);
    } else {
      for (n = "" + Me(n), e = null, o = 0; o < t.length; o++) {
        if (t[o].value === n) {
          (t[o].selected = !0), s && (t[o].defaultSelected = !0);
          return;
        }
        e !== null || t[o].disabled || (e = t[o]);
      }
      e !== null && (e.selected = !0);
    }
  }
  function Uf(t, e, n) {
    if (
      e != null &&
      ((e = "" + Me(e)), e !== t.value && (t.value = e), n == null)
    ) {
      t.defaultValue !== e && (t.defaultValue = e);
      return;
    }
    t.defaultValue = n != null ? "" + Me(n) : "";
  }
  function Bf(t, e, n, s) {
    if (e == null) {
      if (s != null) {
        if (n != null) throw Error(l(92));
        if (Ct(s)) {
          if (1 < s.length) throw Error(l(93));
          s = s[0];
        }
        n = s;
      }
      n == null && (n = ""), (e = n);
    }
    (n = Me(e)),
      (t.defaultValue = n),
      (s = t.textContent),
      s === n && s !== "" && s !== null && (t.value = s);
  }
  function Mi(t, e) {
    if (e) {
      var n = t.firstChild;
      if (n && n === t.lastChild && n.nodeType === 3) {
        n.nodeValue = e;
        return;
      }
    }
    t.textContent = e;
  }
  var sv = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " ",
    ),
  );
  function Hf(t, e, n) {
    var s = e.indexOf("--") === 0;
    n == null || typeof n == "boolean" || n === ""
      ? s
        ? t.setProperty(e, "")
        : e === "float"
          ? (t.cssFloat = "")
          : (t[e] = "")
      : s
        ? t.setProperty(e, n)
        : typeof n != "number" || n === 0 || sv.has(e)
          ? e === "float"
            ? (t.cssFloat = n)
            : (t[e] = ("" + n).trim())
          : (t[e] = n + "px");
  }
  function Gf(t, e, n) {
    if (e != null && typeof e != "object") throw Error(l(62));
    if (((t = t.style), n != null)) {
      for (var s in n)
        !n.hasOwnProperty(s) ||
          (e != null && e.hasOwnProperty(s)) ||
          (s.indexOf("--") === 0
            ? t.setProperty(s, "")
            : s === "float"
              ? (t.cssFloat = "")
              : (t[s] = ""));
      for (var o in e)
        (s = e[o]), e.hasOwnProperty(o) && n[o] !== s && Hf(t, o, s);
    } else for (var u in e) e.hasOwnProperty(u) && Hf(t, u, e[u]);
  }
  function Qr(t) {
    if (t.indexOf("-") === -1) return !1;
    switch (t) {
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        return !1;
      default:
        return !0;
    }
  }
  var lv = new Map([
      ["acceptCharset", "accept-charset"],
      ["htmlFor", "for"],
      ["httpEquiv", "http-equiv"],
      ["crossOrigin", "crossorigin"],
      ["accentHeight", "accent-height"],
      ["alignmentBaseline", "alignment-baseline"],
      ["arabicForm", "arabic-form"],
      ["baselineShift", "baseline-shift"],
      ["capHeight", "cap-height"],
      ["clipPath", "clip-path"],
      ["clipRule", "clip-rule"],
      ["colorInterpolation", "color-interpolation"],
      ["colorInterpolationFilters", "color-interpolation-filters"],
      ["colorProfile", "color-profile"],
      ["colorRendering", "color-rendering"],
      ["dominantBaseline", "dominant-baseline"],
      ["enableBackground", "enable-background"],
      ["fillOpacity", "fill-opacity"],
      ["fillRule", "fill-rule"],
      ["floodColor", "flood-color"],
      ["floodOpacity", "flood-opacity"],
      ["fontFamily", "font-family"],
      ["fontSize", "font-size"],
      ["fontSizeAdjust", "font-size-adjust"],
      ["fontStretch", "font-stretch"],
      ["fontStyle", "font-style"],
      ["fontVariant", "font-variant"],
      ["fontWeight", "font-weight"],
      ["glyphName", "glyph-name"],
      ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
      ["glyphOrientationVertical", "glyph-orientation-vertical"],
      ["horizAdvX", "horiz-adv-x"],
      ["horizOriginX", "horiz-origin-x"],
      ["imageRendering", "image-rendering"],
      ["letterSpacing", "letter-spacing"],
      ["lightingColor", "lighting-color"],
      ["markerEnd", "marker-end"],
      ["markerMid", "marker-mid"],
      ["markerStart", "marker-start"],
      ["overlinePosition", "overline-position"],
      ["overlineThickness", "overline-thickness"],
      ["paintOrder", "paint-order"],
      ["panose-1", "panose-1"],
      ["pointerEvents", "pointer-events"],
      ["renderingIntent", "rendering-intent"],
      ["shapeRendering", "shape-rendering"],
      ["stopColor", "stop-color"],
      ["stopOpacity", "stop-opacity"],
      ["strikethroughPosition", "strikethrough-position"],
      ["strikethroughThickness", "strikethrough-thickness"],
      ["strokeDasharray", "stroke-dasharray"],
      ["strokeDashoffset", "stroke-dashoffset"],
      ["strokeLinecap", "stroke-linecap"],
      ["strokeLinejoin", "stroke-linejoin"],
      ["strokeMiterlimit", "stroke-miterlimit"],
      ["strokeOpacity", "stroke-opacity"],
      ["strokeWidth", "stroke-width"],
      ["textAnchor", "text-anchor"],
      ["textDecoration", "text-decoration"],
      ["textRendering", "text-rendering"],
      ["transformOrigin", "transform-origin"],
      ["underlinePosition", "underline-position"],
      ["underlineThickness", "underline-thickness"],
      ["unicodeBidi", "unicode-bidi"],
      ["unicodeRange", "unicode-range"],
      ["unitsPerEm", "units-per-em"],
      ["vAlphabetic", "v-alphabetic"],
      ["vHanging", "v-hanging"],
      ["vIdeographic", "v-ideographic"],
      ["vMathematical", "v-mathematical"],
      ["vectorEffect", "vector-effect"],
      ["vertAdvY", "vert-adv-y"],
      ["vertOriginX", "vert-origin-x"],
      ["vertOriginY", "vert-origin-y"],
      ["wordSpacing", "word-spacing"],
      ["writingMode", "writing-mode"],
      ["xmlnsXlink", "xmlns:xlink"],
      ["xHeight", "x-height"],
    ]),
    rv =
      /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Zs(t) {
    return rv.test("" + t)
      ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
      : t;
  }
  var Jr = null;
  function Fr(t) {
    return (
      (t = t.target || t.srcElement || window),
      t.correspondingUseElement && (t = t.correspondingUseElement),
      t.nodeType === 3 ? t.parentNode : t
    );
  }
  var Ri = null,
    Di = null;
  function Yf(t) {
    var e = xi(t);
    if (e && (t = e.stateNode)) {
      var n = t[ue] || null;
      t: switch (((t = e.stateNode), e.type)) {
        case "input":
          if (
            (Kr(
              t,
              n.value,
              n.defaultValue,
              n.defaultValue,
              n.checked,
              n.defaultChecked,
              n.type,
              n.name,
            ),
            (e = n.name),
            n.type === "radio" && e != null)
          ) {
            for (n = t; n.parentNode; ) n = n.parentNode;
            for (
              n = n.querySelectorAll(
                'input[name="' + Re("" + e) + '"][type="radio"]',
              ),
                e = 0;
              e < n.length;
              e++
            ) {
              var s = n[e];
              if (s !== t && s.form === t.form) {
                var o = s[ue] || null;
                if (!o) throw Error(l(90));
                Kr(
                  s,
                  o.value,
                  o.defaultValue,
                  o.defaultValue,
                  o.checked,
                  o.defaultChecked,
                  o.type,
                  o.name,
                );
              }
            }
            for (e = 0; e < n.length; e++)
              (s = n[e]), s.form === t.form && Lf(s);
          }
          break t;
        case "textarea":
          Uf(t, n.value, n.defaultValue);
          break t;
        case "select":
          (e = n.value), e != null && Ai(t, !!n.multiple, e, !1);
      }
    }
  }
  var $r = !1;
  function qf(t, e, n) {
    if ($r) return t(e, n);
    $r = !0;
    try {
      var s = t(e);
      return s;
    } finally {
      if (
        (($r = !1),
        (Ri !== null || Di !== null) &&
          (jl(), Ri && ((e = Ri), (t = Di), (Di = Ri = null), Yf(e), t)))
      )
        for (e = 0; e < t.length; e++) Yf(t[e]);
    }
  }
  function Sa(t, e) {
    var n = t.stateNode;
    if (n === null) return null;
    var s = n[ue] || null;
    if (s === null) return null;
    n = s[e];
    t: switch (e) {
      case "onClick":
      case "onClickCapture":
      case "onDoubleClick":
      case "onDoubleClickCapture":
      case "onMouseDown":
      case "onMouseDownCapture":
      case "onMouseMove":
      case "onMouseMoveCapture":
      case "onMouseUp":
      case "onMouseUpCapture":
      case "onMouseEnter":
        (s = !s.disabled) ||
          ((t = t.type),
          (s = !(
            t === "button" ||
            t === "input" ||
            t === "select" ||
            t === "textarea"
          ))),
          (t = !s);
        break t;
      default:
        t = !1;
    }
    if (t) return null;
    if (n && typeof n != "function") throw Error(l(231, e, typeof n));
    return n;
  }
  var Ie = !(
      typeof window > "u" ||
      typeof window.document > "u" ||
      typeof window.document.createElement > "u"
    ),
    Wr = !1;
  if (Ie)
    try {
      var xa = {};
      Object.defineProperty(xa, "passive", {
        get: function () {
          Wr = !0;
        },
      }),
        window.addEventListener("test", xa, xa),
        window.removeEventListener("test", xa, xa);
    } catch {
      Wr = !1;
    }
  var xn = null,
    Ir = null,
    Ks = null;
  function Xf() {
    if (Ks) return Ks;
    var t,
      e = Ir,
      n = e.length,
      s,
      o = "value" in xn ? xn.value : xn.textContent,
      u = o.length;
    for (t = 0; t < n && e[t] === o[t]; t++);
    var h = n - t;
    for (s = 1; s <= h && e[n - s] === o[u - s]; s++);
    return (Ks = o.slice(t, 1 < s ? 1 - s : void 0));
  }
  function Ps(t) {
    var e = t.keyCode;
    return (
      "charCode" in t
        ? ((t = t.charCode), t === 0 && e === 13 && (t = 13))
        : (t = e),
      t === 10 && (t = 13),
      32 <= t || t === 13 ? t : 0
    );
  }
  function Qs() {
    return !0;
  }
  function kf() {
    return !1;
  }
  function ce(t) {
    function e(n, s, o, u, h) {
      (this._reactName = n),
        (this._targetInst = o),
        (this.type = s),
        (this.nativeEvent = u),
        (this.target = h),
        (this.currentTarget = null);
      for (var v in t)
        t.hasOwnProperty(v) && ((n = t[v]), (this[v] = n ? n(u) : u[v]));
      return (
        (this.isDefaultPrevented = (
          u.defaultPrevented != null
            ? u.defaultPrevented
            : u.returnValue === !1
        )
          ? Qs
          : kf),
        (this.isPropagationStopped = kf),
        this
      );
    }
    return (
      g(e.prototype, {
        preventDefault: function () {
          this.defaultPrevented = !0;
          var n = this.nativeEvent;
          n &&
            (n.preventDefault
              ? n.preventDefault()
              : typeof n.returnValue != "unknown" && (n.returnValue = !1),
            (this.isDefaultPrevented = Qs));
        },
        stopPropagation: function () {
          var n = this.nativeEvent;
          n &&
            (n.stopPropagation
              ? n.stopPropagation()
              : typeof n.cancelBubble != "unknown" && (n.cancelBubble = !0),
            (this.isPropagationStopped = Qs));
        },
        persist: function () {},
        isPersistent: Qs,
      }),
      e
    );
  }
  var Pn = {
      eventPhase: 0,
      bubbles: 0,
      cancelable: 0,
      timeStamp: function (t) {
        return t.timeStamp || Date.now();
      },
      defaultPrevented: 0,
      isTrusted: 0,
    },
    Js = ce(Pn),
    ba = g({}, Pn, { view: 0, detail: 0 }),
    ov = ce(ba),
    to,
    eo,
    Ta,
    Fs = g({}, ba, {
      screenX: 0,
      screenY: 0,
      clientX: 0,
      clientY: 0,
      pageX: 0,
      pageY: 0,
      ctrlKey: 0,
      shiftKey: 0,
      altKey: 0,
      metaKey: 0,
      getModifierState: io,
      button: 0,
      buttons: 0,
      relatedTarget: function (t) {
        return t.relatedTarget === void 0
          ? t.fromElement === t.srcElement
            ? t.toElement
            : t.fromElement
          : t.relatedTarget;
      },
      movementX: function (t) {
        return "movementX" in t
          ? t.movementX
          : (t !== Ta &&
              (Ta && t.type === "mousemove"
                ? ((to = t.screenX - Ta.screenX), (eo = t.screenY - Ta.screenY))
                : (eo = to = 0),
              (Ta = t)),
            to);
      },
      movementY: function (t) {
        return "movementY" in t ? t.movementY : eo;
      },
    }),
    Zf = ce(Fs),
    uv = g({}, Fs, { dataTransfer: 0 }),
    cv = ce(uv),
    fv = g({}, ba, { relatedTarget: 0 }),
    no = ce(fv),
    dv = g({}, Pn, { animationName: 0, elapsedTime: 0, pseudoElement: 0 }),
    hv = ce(dv),
    mv = g({}, Pn, {
      clipboardData: function (t) {
        return "clipboardData" in t ? t.clipboardData : window.clipboardData;
      },
    }),
    pv = ce(mv),
    yv = g({}, Pn, { data: 0 }),
    Kf = ce(yv),
    gv = {
      Esc: "Escape",
      Spacebar: " ",
      Left: "ArrowLeft",
      Up: "ArrowUp",
      Right: "ArrowRight",
      Down: "ArrowDown",
      Del: "Delete",
      Win: "OS",
      Menu: "ContextMenu",
      Apps: "ContextMenu",
      Scroll: "ScrollLock",
      MozPrintableKey: "Unidentified",
    },
    vv = {
      8: "Backspace",
      9: "Tab",
      12: "Clear",
      13: "Enter",
      16: "Shift",
      17: "Control",
      18: "Alt",
      19: "Pause",
      20: "CapsLock",
      27: "Escape",
      32: " ",
      33: "PageUp",
      34: "PageDown",
      35: "End",
      36: "Home",
      37: "ArrowLeft",
      38: "ArrowUp",
      39: "ArrowRight",
      40: "ArrowDown",
      45: "Insert",
      46: "Delete",
      112: "F1",
      113: "F2",
      114: "F3",
      115: "F4",
      116: "F5",
      117: "F6",
      118: "F7",
      119: "F8",
      120: "F9",
      121: "F10",
      122: "F11",
      123: "F12",
      144: "NumLock",
      145: "ScrollLock",
      224: "Meta",
    },
    Sv = {
      Alt: "altKey",
      Control: "ctrlKey",
      Meta: "metaKey",
      Shift: "shiftKey",
    };
  function xv(t) {
    var e = this.nativeEvent;
    return e.getModifierState
      ? e.getModifierState(t)
      : (t = Sv[t])
        ? !!e[t]
        : !1;
  }
  function io() {
    return xv;
  }
  var bv = g({}, ba, {
      key: function (t) {
        if (t.key) {
          var e = gv[t.key] || t.key;
          if (e !== "Unidentified") return e;
        }
        return t.type === "keypress"
          ? ((t = Ps(t)), t === 13 ? "Enter" : String.fromCharCode(t))
          : t.type === "keydown" || t.type === "keyup"
            ? vv[t.keyCode] || "Unidentified"
            : "";
      },
      code: 0,
      location: 0,
      ctrlKey: 0,
      shiftKey: 0,
      altKey: 0,
      metaKey: 0,
      repeat: 0,
      locale: 0,
      getModifierState: io,
      charCode: function (t) {
        return t.type === "keypress" ? Ps(t) : 0;
      },
      keyCode: function (t) {
        return t.type === "keydown" || t.type === "keyup" ? t.keyCode : 0;
      },
      which: function (t) {
        return t.type === "keypress"
          ? Ps(t)
          : t.type === "keydown" || t.type === "keyup"
            ? t.keyCode
            : 0;
      },
    }),
    Tv = ce(bv),
    Ev = g({}, Fs, {
      pointerId: 0,
      width: 0,
      height: 0,
      pressure: 0,
      tangentialPressure: 0,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      pointerType: 0,
      isPrimary: 0,
    }),
    Pf = ce(Ev),
    Av = g({}, ba, {
      touches: 0,
      targetTouches: 0,
      changedTouches: 0,
      altKey: 0,
      metaKey: 0,
      ctrlKey: 0,
      shiftKey: 0,
      getModifierState: io,
    }),
    Mv = ce(Av),
    Rv = g({}, Pn, { propertyName: 0, elapsedTime: 0, pseudoElement: 0 }),
    Dv = ce(Rv),
    Ov = g({}, Fs, {
      deltaX: function (t) {
        return "deltaX" in t
          ? t.deltaX
          : "wheelDeltaX" in t
            ? -t.wheelDeltaX
            : 0;
      },
      deltaY: function (t) {
        return "deltaY" in t
          ? t.deltaY
          : "wheelDeltaY" in t
            ? -t.wheelDeltaY
            : "wheelDelta" in t
              ? -t.wheelDelta
              : 0;
      },
      deltaZ: 0,
      deltaMode: 0,
    }),
    Cv = ce(Ov),
    jv = g({}, Pn, { newState: 0, oldState: 0 }),
    Nv = ce(jv),
    wv = [9, 13, 27, 32],
    ao = Ie && "CompositionEvent" in window,
    Ea = null;
  Ie && "documentMode" in document && (Ea = document.documentMode);
  var Vv = Ie && "TextEvent" in window && !Ea,
    Qf = Ie && (!ao || (Ea && 8 < Ea && 11 >= Ea)),
    Jf = " ",
    Ff = !1;
  function $f(t, e) {
    switch (t) {
      case "keyup":
        return wv.indexOf(e.keyCode) !== -1;
      case "keydown":
        return e.keyCode !== 229;
      case "keypress":
      case "mousedown":
      case "focusout":
        return !0;
      default:
        return !1;
    }
  }
  function Wf(t) {
    return (t = t.detail), typeof t == "object" && "data" in t ? t.data : null;
  }
  var Oi = !1;
  function _v(t, e) {
    switch (t) {
      case "compositionend":
        return Wf(e);
      case "keypress":
        return e.which !== 32 ? null : ((Ff = !0), Jf);
      case "textInput":
        return (t = e.data), t === Jf && Ff ? null : t;
      default:
        return null;
    }
  }
  function Lv(t, e) {
    if (Oi)
      return t === "compositionend" || (!ao && $f(t, e))
        ? ((t = Xf()), (Ks = Ir = xn = null), (Oi = !1), t)
        : null;
    switch (t) {
      case "paste":
        return null;
      case "keypress":
        if (!(e.ctrlKey || e.altKey || e.metaKey) || (e.ctrlKey && e.altKey)) {
          if (e.char && 1 < e.char.length) return e.char;
          if (e.which) return String.fromCharCode(e.which);
        }
        return null;
      case "compositionend":
        return Qf && e.locale !== "ko" ? null : e.data;
      default:
        return null;
    }
  }
  var zv = {
    color: !0,
    date: !0,
    datetime: !0,
    "datetime-local": !0,
    email: !0,
    month: !0,
    number: !0,
    password: !0,
    range: !0,
    search: !0,
    tel: !0,
    text: !0,
    time: !0,
    url: !0,
    week: !0,
  };
  function If(t) {
    var e = t && t.nodeName && t.nodeName.toLowerCase();
    return e === "input" ? !!zv[t.type] : e === "textarea";
  }
  function td(t, e, n, s) {
    Ri ? (Di ? Di.push(s) : (Di = [s])) : (Ri = s),
      (e = zl(e, "onChange")),
      0 < e.length &&
        ((n = new Js("onChange", "change", null, n, s)),
        t.push({ event: n, listeners: e }));
  }
  var Aa = null,
    Ma = null;
  function Uv(t) {
    _m(t, 0);
  }
  function $s(t) {
    var e = va(t);
    if (Lf(e)) return t;
  }
  function ed(t, e) {
    if (t === "change") return e;
  }
  var nd = !1;
  if (Ie) {
    var so;
    if (Ie) {
      var lo = "oninput" in document;
      if (!lo) {
        var id = document.createElement("div");
        id.setAttribute("oninput", "return;"),
          (lo = typeof id.oninput == "function");
      }
      so = lo;
    } else so = !1;
    nd = so && (!document.documentMode || 9 < document.documentMode);
  }
  function ad() {
    Aa && (Aa.detachEvent("onpropertychange", sd), (Ma = Aa = null));
  }
  function sd(t) {
    if (t.propertyName === "value" && $s(Ma)) {
      var e = [];
      td(e, Ma, t, Fr(t)), qf(Uv, e);
    }
  }
  function Bv(t, e, n) {
    t === "focusin"
      ? (ad(), (Aa = e), (Ma = n), Aa.attachEvent("onpropertychange", sd))
      : t === "focusout" && ad();
  }
  function Hv(t) {
    if (t === "selectionchange" || t === "keyup" || t === "keydown")
      return $s(Ma);
  }
  function Gv(t, e) {
    if (t === "click") return $s(e);
  }
  function Yv(t, e) {
    if (t === "input" || t === "change") return $s(e);
  }
  function qv(t, e) {
    return (t === e && (t !== 0 || 1 / t === 1 / e)) || (t !== t && e !== e);
  }
  var ge = typeof Object.is == "function" ? Object.is : qv;
  function Ra(t, e) {
    if (ge(t, e)) return !0;
    if (
      typeof t != "object" ||
      t === null ||
      typeof e != "object" ||
      e === null
    )
      return !1;
    var n = Object.keys(t),
      s = Object.keys(e);
    if (n.length !== s.length) return !1;
    for (s = 0; s < n.length; s++) {
      var o = n[s];
      if (!Lr.call(e, o) || !ge(t[o], e[o])) return !1;
    }
    return !0;
  }
  function ld(t) {
    for (; t && t.firstChild; ) t = t.firstChild;
    return t;
  }
  function rd(t, e) {
    var n = ld(t);
    t = 0;
    for (var s; n; ) {
      if (n.nodeType === 3) {
        if (((s = t + n.textContent.length), t <= e && s >= e))
          return { node: n, offset: e - t };
        t = s;
      }
      t: {
        for (; n; ) {
          if (n.nextSibling) {
            n = n.nextSibling;
            break t;
          }
          n = n.parentNode;
        }
        n = void 0;
      }
      n = ld(n);
    }
  }
  function od(t, e) {
    return t && e
      ? t === e
        ? !0
        : t && t.nodeType === 3
          ? !1
          : e && e.nodeType === 3
            ? od(t, e.parentNode)
            : "contains" in t
              ? t.contains(e)
              : t.compareDocumentPosition
                ? !!(t.compareDocumentPosition(e) & 16)
                : !1
      : !1;
  }
  function ud(t) {
    t =
      t != null &&
      t.ownerDocument != null &&
      t.ownerDocument.defaultView != null
        ? t.ownerDocument.defaultView
        : window;
    for (var e = ks(t.document); e instanceof t.HTMLIFrameElement; ) {
      try {
        var n = typeof e.contentWindow.location.href == "string";
      } catch {
        n = !1;
      }
      if (n) t = e.contentWindow;
      else break;
      e = ks(t.document);
    }
    return e;
  }
  function ro(t) {
    var e = t && t.nodeName && t.nodeName.toLowerCase();
    return (
      e &&
      ((e === "input" &&
        (t.type === "text" ||
          t.type === "search" ||
          t.type === "tel" ||
          t.type === "url" ||
          t.type === "password")) ||
        e === "textarea" ||
        t.contentEditable === "true")
    );
  }
  var Xv = Ie && "documentMode" in document && 11 >= document.documentMode,
    Ci = null,
    oo = null,
    Da = null,
    uo = !1;
  function cd(t, e, n) {
    var s =
      n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
    uo ||
      Ci == null ||
      Ci !== ks(s) ||
      ((s = Ci),
      "selectionStart" in s && ro(s)
        ? (s = { start: s.selectionStart, end: s.selectionEnd })
        : ((s = (
            (s.ownerDocument && s.ownerDocument.defaultView) ||
            window
          ).getSelection()),
          (s = {
            anchorNode: s.anchorNode,
            anchorOffset: s.anchorOffset,
            focusNode: s.focusNode,
            focusOffset: s.focusOffset,
          })),
      (Da && Ra(Da, s)) ||
        ((Da = s),
        (s = zl(oo, "onSelect")),
        0 < s.length &&
          ((e = new Js("onSelect", "select", null, e, n)),
          t.push({ event: e, listeners: s }),
          (e.target = Ci))));
  }
  function Qn(t, e) {
    var n = {};
    return (
      (n[t.toLowerCase()] = e.toLowerCase()),
      (n["Webkit" + t] = "webkit" + e),
      (n["Moz" + t] = "moz" + e),
      n
    );
  }
  var ji = {
      animationend: Qn("Animation", "AnimationEnd"),
      animationiteration: Qn("Animation", "AnimationIteration"),
      animationstart: Qn("Animation", "AnimationStart"),
      transitionrun: Qn("Transition", "TransitionRun"),
      transitionstart: Qn("Transition", "TransitionStart"),
      transitioncancel: Qn("Transition", "TransitionCancel"),
      transitionend: Qn("Transition", "TransitionEnd"),
    },
    co = {},
    fd = {};
  Ie &&
    ((fd = document.createElement("div").style),
    "AnimationEvent" in window ||
      (delete ji.animationend.animation,
      delete ji.animationiteration.animation,
      delete ji.animationstart.animation),
    "TransitionEvent" in window || delete ji.transitionend.transition);
  function Jn(t) {
    if (co[t]) return co[t];
    if (!ji[t]) return t;
    var e = ji[t],
      n;
    for (n in e) if (e.hasOwnProperty(n) && n in fd) return (co[t] = e[n]);
    return t;
  }
  var dd = Jn("animationend"),
    hd = Jn("animationiteration"),
    md = Jn("animationstart"),
    kv = Jn("transitionrun"),
    Zv = Jn("transitionstart"),
    Kv = Jn("transitioncancel"),
    pd = Jn("transitionend"),
    yd = new Map(),
    fo =
      "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
        " ",
      );
  fo.push("scrollEnd");
  function ze(t, e) {
    yd.set(t, e), Kn(e, [t]);
  }
  var gd = new WeakMap();
  function De(t, e) {
    if (typeof t == "object" && t !== null) {
      var n = gd.get(t);
      return n !== void 0
        ? n
        : ((e = { value: t, source: e, stack: Vf(e) }), gd.set(t, e), e);
    }
    return { value: t, source: e, stack: Vf(e) };
  }
  var Oe = [],
    Ni = 0,
    ho = 0;
  function Ws() {
    for (var t = Ni, e = (ho = Ni = 0); e < t; ) {
      var n = Oe[e];
      Oe[e++] = null;
      var s = Oe[e];
      Oe[e++] = null;
      var o = Oe[e];
      Oe[e++] = null;
      var u = Oe[e];
      if (((Oe[e++] = null), s !== null && o !== null)) {
        var h = s.pending;
        h === null ? (o.next = o) : ((o.next = h.next), (h.next = o)),
          (s.pending = o);
      }
      u !== 0 && vd(n, o, u);
    }
  }
  function Is(t, e, n, s) {
    (Oe[Ni++] = t),
      (Oe[Ni++] = e),
      (Oe[Ni++] = n),
      (Oe[Ni++] = s),
      (ho |= s),
      (t.lanes |= s),
      (t = t.alternate),
      t !== null && (t.lanes |= s);
  }
  function mo(t, e, n, s) {
    return Is(t, e, n, s), tl(t);
  }
  function wi(t, e) {
    return Is(t, null, null, e), tl(t);
  }
  function vd(t, e, n) {
    t.lanes |= n;
    var s = t.alternate;
    s !== null && (s.lanes |= n);
    for (var o = !1, u = t.return; u !== null; )
      (u.childLanes |= n),
        (s = u.alternate),
        s !== null && (s.childLanes |= n),
        u.tag === 22 &&
          ((t = u.stateNode), t === null || t._visibility & 1 || (o = !0)),
        (t = u),
        (u = u.return);
    return t.tag === 3
      ? ((u = t.stateNode),
        o &&
          e !== null &&
          ((o = 31 - ye(n)),
          (t = u.hiddenUpdates),
          (s = t[o]),
          s === null ? (t[o] = [e]) : s.push(e),
          (e.lane = n | 536870912)),
        u)
      : null;
  }
  function tl(t) {
    if (50 < Wa) throw ((Wa = 0), (xu = null), Error(l(185)));
    for (var e = t.return; e !== null; ) (t = e), (e = t.return);
    return t.tag === 3 ? t.stateNode : null;
  }
  var Vi = {};
  function Pv(t, e, n, s) {
    (this.tag = t),
      (this.key = n),
      (this.sibling =
        this.child =
        this.return =
        this.stateNode =
        this.type =
        this.elementType =
          null),
      (this.index = 0),
      (this.refCleanup = this.ref = null),
      (this.pendingProps = e),
      (this.dependencies =
        this.memoizedState =
        this.updateQueue =
        this.memoizedProps =
          null),
      (this.mode = s),
      (this.subtreeFlags = this.flags = 0),
      (this.deletions = null),
      (this.childLanes = this.lanes = 0),
      (this.alternate = null);
  }
  function ve(t, e, n, s) {
    return new Pv(t, e, n, s);
  }
  function po(t) {
    return (t = t.prototype), !(!t || !t.isReactComponent);
  }
  function tn(t, e) {
    var n = t.alternate;
    return (
      n === null
        ? ((n = ve(t.tag, e, t.key, t.mode)),
          (n.elementType = t.elementType),
          (n.type = t.type),
          (n.stateNode = t.stateNode),
          (n.alternate = t),
          (t.alternate = n))
        : ((n.pendingProps = e),
          (n.type = t.type),
          (n.flags = 0),
          (n.subtreeFlags = 0),
          (n.deletions = null)),
      (n.flags = t.flags & 65011712),
      (n.childLanes = t.childLanes),
      (n.lanes = t.lanes),
      (n.child = t.child),
      (n.memoizedProps = t.memoizedProps),
      (n.memoizedState = t.memoizedState),
      (n.updateQueue = t.updateQueue),
      (e = t.dependencies),
      (n.dependencies =
        e === null ? null : { lanes: e.lanes, firstContext: e.firstContext }),
      (n.sibling = t.sibling),
      (n.index = t.index),
      (n.ref = t.ref),
      (n.refCleanup = t.refCleanup),
      n
    );
  }
  function Sd(t, e) {
    t.flags &= 65011714;
    var n = t.alternate;
    return (
      n === null
        ? ((t.childLanes = 0),
          (t.lanes = e),
          (t.child = null),
          (t.subtreeFlags = 0),
          (t.memoizedProps = null),
          (t.memoizedState = null),
          (t.updateQueue = null),
          (t.dependencies = null),
          (t.stateNode = null))
        : ((t.childLanes = n.childLanes),
          (t.lanes = n.lanes),
          (t.child = n.child),
          (t.subtreeFlags = 0),
          (t.deletions = null),
          (t.memoizedProps = n.memoizedProps),
          (t.memoizedState = n.memoizedState),
          (t.updateQueue = n.updateQueue),
          (t.type = n.type),
          (e = n.dependencies),
          (t.dependencies =
            e === null
              ? null
              : { lanes: e.lanes, firstContext: e.firstContext })),
      t
    );
  }
  function el(t, e, n, s, o, u) {
    var h = 0;
    if (((s = t), typeof t == "function")) po(t) && (h = 1);
    else if (typeof t == "string")
      h = J1(t, n, nt.current)
        ? 26
        : t === "html" || t === "head" || t === "body"
          ? 27
          : 5;
    else
      t: switch (t) {
        case lt:
          return (t = ve(31, n, e, o)), (t.elementType = lt), (t.lanes = u), t;
        case A:
          return Fn(n.children, o, u, e);
        case R:
          (h = 8), (o |= 24);
          break;
        case V:
          return (
            (t = ve(12, n, e, o | 2)), (t.elementType = V), (t.lanes = u), t
          );
        case k:
          return (t = ve(13, n, e, o)), (t.elementType = k), (t.lanes = u), t;
        case tt:
          return (t = ve(19, n, e, o)), (t.elementType = tt), (t.lanes = u), t;
        default:
          if (typeof t == "object" && t !== null)
            switch (t.$$typeof) {
              case L:
              case H:
                h = 10;
                break t;
              case _:
                h = 9;
                break t;
              case X:
                h = 11;
                break t;
              case et:
                h = 14;
                break t;
              case P:
                (h = 16), (s = null);
                break t;
            }
          (h = 29),
            (n = Error(l(130, t === null ? "null" : typeof t, ""))),
            (s = null);
      }
    return (
      (e = ve(h, n, e, o)), (e.elementType = t), (e.type = s), (e.lanes = u), e
    );
  }
  function Fn(t, e, n, s) {
    return (t = ve(7, t, s, e)), (t.lanes = n), t;
  }
  function yo(t, e, n) {
    return (t = ve(6, t, null, e)), (t.lanes = n), t;
  }
  function go(t, e, n) {
    return (
      (e = ve(4, t.children !== null ? t.children : [], t.key, e)),
      (e.lanes = n),
      (e.stateNode = {
        containerInfo: t.containerInfo,
        pendingChildren: null,
        implementation: t.implementation,
      }),
      e
    );
  }
  var _i = [],
    Li = 0,
    nl = null,
    il = 0,
    Ce = [],
    je = 0,
    $n = null,
    en = 1,
    nn = "";
  function Wn(t, e) {
    (_i[Li++] = il), (_i[Li++] = nl), (nl = t), (il = e);
  }
  function xd(t, e, n) {
    (Ce[je++] = en), (Ce[je++] = nn), (Ce[je++] = $n), ($n = t);
    var s = en;
    t = nn;
    var o = 32 - ye(s) - 1;
    (s &= ~(1 << o)), (n += 1);
    var u = 32 - ye(e) + o;
    if (30 < u) {
      var h = o - (o % 5);
      (u = (s & ((1 << h) - 1)).toString(32)),
        (s >>= h),
        (o -= h),
        (en = (1 << (32 - ye(e) + o)) | (n << o) | s),
        (nn = u + t);
    } else (en = (1 << u) | (n << o) | s), (nn = t);
  }
  function vo(t) {
    t.return !== null && (Wn(t, 1), xd(t, 1, 0));
  }
  function So(t) {
    for (; t === nl; )
      (nl = _i[--Li]), (_i[Li] = null), (il = _i[--Li]), (_i[Li] = null);
    for (; t === $n; )
      ($n = Ce[--je]),
        (Ce[je] = null),
        (nn = Ce[--je]),
        (Ce[je] = null),
        (en = Ce[--je]),
        (Ce[je] = null);
  }
  var le = null,
    Lt = null,
    xt = !1,
    In = null,
    Xe = !1,
    xo = Error(l(519));
  function ti(t) {
    var e = Error(l(418, ""));
    throw (ja(De(e, t)), xo);
  }
  function bd(t) {
    var e = t.stateNode,
      n = t.type,
      s = t.memoizedProps;
    switch (((e[ie] = t), (e[ue] = s), n)) {
      case "dialog":
        ht("cancel", e), ht("close", e);
        break;
      case "iframe":
      case "object":
      case "embed":
        ht("load", e);
        break;
      case "video":
      case "audio":
        for (n = 0; n < ts.length; n++) ht(ts[n], e);
        break;
      case "source":
        ht("error", e);
        break;
      case "img":
      case "image":
      case "link":
        ht("error", e), ht("load", e);
        break;
      case "details":
        ht("toggle", e);
        break;
      case "input":
        ht("invalid", e),
          zf(
            e,
            s.value,
            s.defaultValue,
            s.checked,
            s.defaultChecked,
            s.type,
            s.name,
            !0,
          ),
          Xs(e);
        break;
      case "select":
        ht("invalid", e);
        break;
      case "textarea":
        ht("invalid", e), Bf(e, s.value, s.defaultValue, s.children), Xs(e);
    }
    (n = s.children),
      (typeof n != "string" && typeof n != "number" && typeof n != "bigint") ||
      e.textContent === "" + n ||
      s.suppressHydrationWarning === !0 ||
      Bm(e.textContent, n)
        ? (s.popover != null && (ht("beforetoggle", e), ht("toggle", e)),
          s.onScroll != null && ht("scroll", e),
          s.onScrollEnd != null && ht("scrollend", e),
          s.onClick != null && (e.onclick = Ul),
          (e = !0))
        : (e = !1),
      e || ti(t);
  }
  function Td(t) {
    for (le = t.return; le; )
      switch (le.tag) {
        case 5:
        case 13:
          Xe = !1;
          return;
        case 27:
        case 3:
          Xe = !0;
          return;
        default:
          le = le.return;
      }
  }
  function Oa(t) {
    if (t !== le) return !1;
    if (!xt) return Td(t), (xt = !0), !1;
    var e = t.tag,
      n;
    if (
      ((n = e !== 3 && e !== 27) &&
        ((n = e === 5) &&
          ((n = t.type),
          (n =
            !(n !== "form" && n !== "button") || zu(t.type, t.memoizedProps))),
        (n = !n)),
      n && Lt && ti(t),
      Td(t),
      e === 13)
    ) {
      if (((t = t.memoizedState), (t = t !== null ? t.dehydrated : null), !t))
        throw Error(l(317));
      t: {
        for (t = t.nextSibling, e = 0; t; ) {
          if (t.nodeType === 8)
            if (((n = t.data), n === "/$")) {
              if (e === 0) {
                Lt = Be(t.nextSibling);
                break t;
              }
              e--;
            } else (n !== "$" && n !== "$!" && n !== "$?") || e++;
          t = t.nextSibling;
        }
        Lt = null;
      }
    } else
      e === 27
        ? ((e = Lt), zn(t.type) ? ((t = Gu), (Gu = null), (Lt = t)) : (Lt = e))
        : (Lt = le ? Be(t.stateNode.nextSibling) : null);
    return !0;
  }
  function Ca() {
    (Lt = le = null), (xt = !1);
  }
  function Ed() {
    var t = In;
    return (
      t !== null &&
        (he === null ? (he = t) : he.push.apply(he, t), (In = null)),
      t
    );
  }
  function ja(t) {
    In === null ? (In = [t]) : In.push(t);
  }
  var bo = q(null),
    ei = null,
    an = null;
  function bn(t, e, n) {
    K(bo, e._currentValue), (e._currentValue = n);
  }
  function sn(t) {
    (t._currentValue = bo.current), Q(bo);
  }
  function To(t, e, n) {
    for (; t !== null; ) {
      var s = t.alternate;
      if (
        ((t.childLanes & e) !== e
          ? ((t.childLanes |= e), s !== null && (s.childLanes |= e))
          : s !== null && (s.childLanes & e) !== e && (s.childLanes |= e),
        t === n)
      )
        break;
      t = t.return;
    }
  }
  function Eo(t, e, n, s) {
    var o = t.child;
    for (o !== null && (o.return = t); o !== null; ) {
      var u = o.dependencies;
      if (u !== null) {
        var h = o.child;
        u = u.firstContext;
        t: for (; u !== null; ) {
          var v = u;
          u = o;
          for (var T = 0; T < e.length; T++)
            if (v.context === e[T]) {
              (u.lanes |= n),
                (v = u.alternate),
                v !== null && (v.lanes |= n),
                To(u.return, n, t),
                s || (h = null);
              break t;
            }
          u = v.next;
        }
      } else if (o.tag === 18) {
        if (((h = o.return), h === null)) throw Error(l(341));
        (h.lanes |= n),
          (u = h.alternate),
          u !== null && (u.lanes |= n),
          To(h, n, t),
          (h = null);
      } else h = o.child;
      if (h !== null) h.return = o;
      else
        for (h = o; h !== null; ) {
          if (h === t) {
            h = null;
            break;
          }
          if (((o = h.sibling), o !== null)) {
            (o.return = h.return), (h = o);
            break;
          }
          h = h.return;
        }
      o = h;
    }
  }
  function Na(t, e, n, s) {
    t = null;
    for (var o = e, u = !1; o !== null; ) {
      if (!u) {
        if ((o.flags & 524288) !== 0) u = !0;
        else if ((o.flags & 262144) !== 0) break;
      }
      if (o.tag === 10) {
        var h = o.alternate;
        if (h === null) throw Error(l(387));
        if (((h = h.memoizedProps), h !== null)) {
          var v = o.type;
          ge(o.pendingProps.value, h.value) ||
            (t !== null ? t.push(v) : (t = [v]));
        }
      } else if (o === me.current) {
        if (((h = o.alternate), h === null)) throw Error(l(387));
        h.memoizedState.memoizedState !== o.memoizedState.memoizedState &&
          (t !== null ? t.push(ls) : (t = [ls]));
      }
      o = o.return;
    }
    t !== null && Eo(e, t, n, s), (e.flags |= 262144);
  }
  function al(t) {
    for (t = t.firstContext; t !== null; ) {
      if (!ge(t.context._currentValue, t.memoizedValue)) return !0;
      t = t.next;
    }
    return !1;
  }
  function ni(t) {
    (ei = t),
      (an = null),
      (t = t.dependencies),
      t !== null && (t.firstContext = null);
  }
  function ae(t) {
    return Ad(ei, t);
  }
  function sl(t, e) {
    return ei === null && ni(t), Ad(t, e);
  }
  function Ad(t, e) {
    var n = e._currentValue;
    if (((e = { context: e, memoizedValue: n, next: null }), an === null)) {
      if (t === null) throw Error(l(308));
      (an = e),
        (t.dependencies = { lanes: 0, firstContext: e }),
        (t.flags |= 524288);
    } else an = an.next = e;
    return n;
  }
  var Qv =
      typeof AbortController < "u"
        ? AbortController
        : function () {
            var t = [],
              e = (this.signal = {
                aborted: !1,
                addEventListener: function (n, s) {
                  t.push(s);
                },
              });
            this.abort = function () {
              (e.aborted = !0),
                t.forEach(function (n) {
                  return n();
                });
            };
          },
    Jv = i.unstable_scheduleCallback,
    Fv = i.unstable_NormalPriority,
    Xt = {
      $$typeof: H,
      Consumer: null,
      Provider: null,
      _currentValue: null,
      _currentValue2: null,
      _threadCount: 0,
    };
  function Ao() {
    return { controller: new Qv(), data: new Map(), refCount: 0 };
  }
  function wa(t) {
    t.refCount--,
      t.refCount === 0 &&
        Jv(Fv, function () {
          t.controller.abort();
        });
  }
  var Va = null,
    Mo = 0,
    zi = 0,
    Ui = null;
  function $v(t, e) {
    if (Va === null) {
      var n = (Va = []);
      (Mo = 0),
        (zi = Du()),
        (Ui = {
          status: "pending",
          value: void 0,
          then: function (s) {
            n.push(s);
          },
        });
    }
    return Mo++, e.then(Md, Md), e;
  }
  function Md() {
    if (--Mo === 0 && Va !== null) {
      Ui !== null && (Ui.status = "fulfilled");
      var t = Va;
      (Va = null), (zi = 0), (Ui = null);
      for (var e = 0; e < t.length; e++) (0, t[e])();
    }
  }
  function Wv(t, e) {
    var n = [],
      s = {
        status: "pending",
        value: null,
        reason: null,
        then: function (o) {
          n.push(o);
        },
      };
    return (
      t.then(
        function () {
          (s.status = "fulfilled"), (s.value = e);
          for (var o = 0; o < n.length; o++) (0, n[o])(e);
        },
        function (o) {
          for (s.status = "rejected", s.reason = o, o = 0; o < n.length; o++)
            (0, n[o])(void 0);
        },
      ),
      s
    );
  }
  var Rd = z.S;
  z.S = function (t, e) {
    typeof e == "object" &&
      e !== null &&
      typeof e.then == "function" &&
      $v(t, e),
      Rd !== null && Rd(t, e);
  };
  var ii = q(null);
  function Ro() {
    var t = ii.current;
    return t !== null ? t : jt.pooledCache;
  }
  function ll(t, e) {
    e === null ? K(ii, ii.current) : K(ii, e.pool);
  }
  function Dd() {
    var t = Ro();
    return t === null ? null : { parent: Xt._currentValue, pool: t };
  }
  var _a = Error(l(460)),
    Od = Error(l(474)),
    rl = Error(l(542)),
    Do = { then: function () {} };
  function Cd(t) {
    return (t = t.status), t === "fulfilled" || t === "rejected";
  }
  function ol() {}
  function jd(t, e, n) {
    switch (
      ((n = t[n]),
      n === void 0 ? t.push(e) : n !== e && (e.then(ol, ol), (e = n)),
      e.status)
    ) {
      case "fulfilled":
        return e.value;
      case "rejected":
        throw ((t = e.reason), wd(t), t);
      default:
        if (typeof e.status == "string") e.then(ol, ol);
        else {
          if (((t = jt), t !== null && 100 < t.shellSuspendCounter))
            throw Error(l(482));
          (t = e),
            (t.status = "pending"),
            t.then(
              function (s) {
                if (e.status === "pending") {
                  var o = e;
                  (o.status = "fulfilled"), (o.value = s);
                }
              },
              function (s) {
                if (e.status === "pending") {
                  var o = e;
                  (o.status = "rejected"), (o.reason = s);
                }
              },
            );
        }
        switch (e.status) {
          case "fulfilled":
            return e.value;
          case "rejected":
            throw ((t = e.reason), wd(t), t);
        }
        throw ((La = e), _a);
    }
  }
  var La = null;
  function Nd() {
    if (La === null) throw Error(l(459));
    var t = La;
    return (La = null), t;
  }
  function wd(t) {
    if (t === _a || t === rl) throw Error(l(483));
  }
  var Tn = !1;
  function Oo(t) {
    t.updateQueue = {
      baseState: t.memoizedState,
      firstBaseUpdate: null,
      lastBaseUpdate: null,
      shared: { pending: null, lanes: 0, hiddenCallbacks: null },
      callbacks: null,
    };
  }
  function Co(t, e) {
    (t = t.updateQueue),
      e.updateQueue === t &&
        (e.updateQueue = {
          baseState: t.baseState,
          firstBaseUpdate: t.firstBaseUpdate,
          lastBaseUpdate: t.lastBaseUpdate,
          shared: t.shared,
          callbacks: null,
        });
  }
  function En(t) {
    return { lane: t, tag: 0, payload: null, callback: null, next: null };
  }
  function An(t, e, n) {
    var s = t.updateQueue;
    if (s === null) return null;
    if (((s = s.shared), (bt & 2) !== 0)) {
      var o = s.pending;
      return (
        o === null ? (e.next = e) : ((e.next = o.next), (o.next = e)),
        (s.pending = e),
        (e = tl(t)),
        vd(t, null, n),
        e
      );
    }
    return Is(t, s, e, n), tl(t);
  }
  function za(t, e, n) {
    if (
      ((e = e.updateQueue), e !== null && ((e = e.shared), (n & 4194048) !== 0))
    ) {
      var s = e.lanes;
      (s &= t.pendingLanes), (n |= s), (e.lanes = n), Mf(t, n);
    }
  }
  function jo(t, e) {
    var n = t.updateQueue,
      s = t.alternate;
    if (s !== null && ((s = s.updateQueue), n === s)) {
      var o = null,
        u = null;
      if (((n = n.firstBaseUpdate), n !== null)) {
        do {
          var h = {
            lane: n.lane,
            tag: n.tag,
            payload: n.payload,
            callback: null,
            next: null,
          };
          u === null ? (o = u = h) : (u = u.next = h), (n = n.next);
        } while (n !== null);
        u === null ? (o = u = e) : (u = u.next = e);
      } else o = u = e;
      (n = {
        baseState: s.baseState,
        firstBaseUpdate: o,
        lastBaseUpdate: u,
        shared: s.shared,
        callbacks: s.callbacks,
      }),
        (t.updateQueue = n);
      return;
    }
    (t = n.lastBaseUpdate),
      t === null ? (n.firstBaseUpdate = e) : (t.next = e),
      (n.lastBaseUpdate = e);
  }
  var No = !1;
  function Ua() {
    if (No) {
      var t = Ui;
      if (t !== null) throw t;
    }
  }
  function Ba(t, e, n, s) {
    No = !1;
    var o = t.updateQueue;
    Tn = !1;
    var u = o.firstBaseUpdate,
      h = o.lastBaseUpdate,
      v = o.shared.pending;
    if (v !== null) {
      o.shared.pending = null;
      var T = v,
        C = T.next;
      (T.next = null), h === null ? (u = C) : (h.next = C), (h = T);
      var B = t.alternate;
      B !== null &&
        ((B = B.updateQueue),
        (v = B.lastBaseUpdate),
        v !== h &&
          (v === null ? (B.firstBaseUpdate = C) : (v.next = C),
          (B.lastBaseUpdate = T)));
    }
    if (u !== null) {
      var Y = o.baseState;
      (h = 0), (B = C = T = null), (v = u);
      do {
        var N = v.lane & -536870913,
          w = N !== v.lane;
        if (w ? (yt & N) === N : (s & N) === N) {
          N !== 0 && N === zi && (No = !0),
            B !== null &&
              (B = B.next =
                {
                  lane: 0,
                  tag: v.tag,
                  payload: v.payload,
                  callback: null,
                  next: null,
                });
          t: {
            var st = t,
              it = v;
            N = e;
            var Rt = n;
            switch (it.tag) {
              case 1:
                if (((st = it.payload), typeof st == "function")) {
                  Y = st.call(Rt, Y, N);
                  break t;
                }
                Y = st;
                break t;
              case 3:
                st.flags = (st.flags & -65537) | 128;
              case 0:
                if (
                  ((st = it.payload),
                  (N = typeof st == "function" ? st.call(Rt, Y, N) : st),
                  N == null)
                )
                  break t;
                Y = g({}, Y, N);
                break t;
              case 2:
                Tn = !0;
            }
          }
          (N = v.callback),
            N !== null &&
              ((t.flags |= 64),
              w && (t.flags |= 8192),
              (w = o.callbacks),
              w === null ? (o.callbacks = [N]) : w.push(N));
        } else
          (w = {
            lane: N,
            tag: v.tag,
            payload: v.payload,
            callback: v.callback,
            next: null,
          }),
            B === null ? ((C = B = w), (T = Y)) : (B = B.next = w),
            (h |= N);
        if (((v = v.next), v === null)) {
          if (((v = o.shared.pending), v === null)) break;
          (w = v),
            (v = w.next),
            (w.next = null),
            (o.lastBaseUpdate = w),
            (o.shared.pending = null);
        }
      } while (!0);
      B === null && (T = Y),
        (o.baseState = T),
        (o.firstBaseUpdate = C),
        (o.lastBaseUpdate = B),
        u === null && (o.shared.lanes = 0),
        (wn |= h),
        (t.lanes = h),
        (t.memoizedState = Y);
    }
  }
  function Vd(t, e) {
    if (typeof t != "function") throw Error(l(191, t));
    t.call(e);
  }
  function _d(t, e) {
    var n = t.callbacks;
    if (n !== null)
      for (t.callbacks = null, t = 0; t < n.length; t++) Vd(n[t], e);
  }
  var Bi = q(null),
    ul = q(0);
  function Ld(t, e) {
    (t = dn), K(ul, t), K(Bi, e), (dn = t | e.baseLanes);
  }
  function wo() {
    K(ul, dn), K(Bi, Bi.current);
  }
  function Vo() {
    (dn = ul.current), Q(Bi), Q(ul);
  }
  var Mn = 0,
    ct = null,
    At = null,
    Gt = null,
    cl = !1,
    Hi = !1,
    ai = !1,
    fl = 0,
    Ha = 0,
    Gi = null,
    Iv = 0;
  function Bt() {
    throw Error(l(321));
  }
  function _o(t, e) {
    if (e === null) return !1;
    for (var n = 0; n < e.length && n < t.length; n++)
      if (!ge(t[n], e[n])) return !1;
    return !0;
  }
  function Lo(t, e, n, s, o, u) {
    return (
      (Mn = u),
      (ct = e),
      (e.memoizedState = null),
      (e.updateQueue = null),
      (e.lanes = 0),
      (z.H = t === null || t.memoizedState === null ? vh : Sh),
      (ai = !1),
      (u = n(s, o)),
      (ai = !1),
      Hi && (u = Ud(e, n, s, o)),
      zd(t),
      u
    );
  }
  function zd(t) {
    z.H = gl;
    var e = At !== null && At.next !== null;
    if (((Mn = 0), (Gt = At = ct = null), (cl = !1), (Ha = 0), (Gi = null), e))
      throw Error(l(300));
    t === null ||
      Qt ||
      ((t = t.dependencies), t !== null && al(t) && (Qt = !0));
  }
  function Ud(t, e, n, s) {
    ct = t;
    var o = 0;
    do {
      if ((Hi && (Gi = null), (Ha = 0), (Hi = !1), 25 <= o))
        throw Error(l(301));
      if (((o += 1), (Gt = At = null), t.updateQueue != null)) {
        var u = t.updateQueue;
        (u.lastEffect = null),
          (u.events = null),
          (u.stores = null),
          u.memoCache != null && (u.memoCache.index = 0);
      }
      (z.H = l1), (u = e(n, s));
    } while (Hi);
    return u;
  }
  function t1() {
    var t = z.H,
      e = t.useState()[0];
    return (
      (e = typeof e.then == "function" ? Ga(e) : e),
      (t = t.useState()[0]),
      (At !== null ? At.memoizedState : null) !== t && (ct.flags |= 1024),
      e
    );
  }
  function zo() {
    var t = fl !== 0;
    return (fl = 0), t;
  }
  function Uo(t, e, n) {
    (e.updateQueue = t.updateQueue), (e.flags &= -2053), (t.lanes &= ~n);
  }
  function Bo(t) {
    if (cl) {
      for (t = t.memoizedState; t !== null; ) {
        var e = t.queue;
        e !== null && (e.pending = null), (t = t.next);
      }
      cl = !1;
    }
    (Mn = 0), (Gt = At = ct = null), (Hi = !1), (Ha = fl = 0), (Gi = null);
  }
  function fe() {
    var t = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null,
    };
    return Gt === null ? (ct.memoizedState = Gt = t) : (Gt = Gt.next = t), Gt;
  }
  function Yt() {
    if (At === null) {
      var t = ct.alternate;
      t = t !== null ? t.memoizedState : null;
    } else t = At.next;
    var e = Gt === null ? ct.memoizedState : Gt.next;
    if (e !== null) (Gt = e), (At = t);
    else {
      if (t === null)
        throw ct.alternate === null ? Error(l(467)) : Error(l(310));
      (At = t),
        (t = {
          memoizedState: At.memoizedState,
          baseState: At.baseState,
          baseQueue: At.baseQueue,
          queue: At.queue,
          next: null,
        }),
        Gt === null ? (ct.memoizedState = Gt = t) : (Gt = Gt.next = t);
    }
    return Gt;
  }
  function Ho() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function Ga(t) {
    var e = Ha;
    return (
      (Ha += 1),
      Gi === null && (Gi = []),
      (t = jd(Gi, t, e)),
      (e = ct),
      (Gt === null ? e.memoizedState : Gt.next) === null &&
        ((e = e.alternate),
        (z.H = e === null || e.memoizedState === null ? vh : Sh)),
      t
    );
  }
  function dl(t) {
    if (t !== null && typeof t == "object") {
      if (typeof t.then == "function") return Ga(t);
      if (t.$$typeof === H) return ae(t);
    }
    throw Error(l(438, String(t)));
  }
  function Go(t) {
    var e = null,
      n = ct.updateQueue;
    if ((n !== null && (e = n.memoCache), e == null)) {
      var s = ct.alternate;
      s !== null &&
        ((s = s.updateQueue),
        s !== null &&
          ((s = s.memoCache),
          s != null &&
            (e = {
              data: s.data.map(function (o) {
                return o.slice();
              }),
              index: 0,
            })));
    }
    if (
      (e == null && (e = { data: [], index: 0 }),
      n === null && ((n = Ho()), (ct.updateQueue = n)),
      (n.memoCache = e),
      (n = e.data[e.index]),
      n === void 0)
    )
      for (n = e.data[e.index] = Array(t), s = 0; s < t; s++) n[s] = W;
    return e.index++, n;
  }
  function ln(t, e) {
    return typeof e == "function" ? e(t) : e;
  }
  function hl(t) {
    var e = Yt();
    return Yo(e, At, t);
  }
  function Yo(t, e, n) {
    var s = t.queue;
    if (s === null) throw Error(l(311));
    s.lastRenderedReducer = n;
    var o = t.baseQueue,
      u = s.pending;
    if (u !== null) {
      if (o !== null) {
        var h = o.next;
        (o.next = u.next), (u.next = h);
      }
      (e.baseQueue = o = u), (s.pending = null);
    }
    if (((u = t.baseState), o === null)) t.memoizedState = u;
    else {
      e = o.next;
      var v = (h = null),
        T = null,
        C = e,
        B = !1;
      do {
        var Y = C.lane & -536870913;
        if (Y !== C.lane ? (yt & Y) === Y : (Mn & Y) === Y) {
          var N = C.revertLane;
          if (N === 0)
            T !== null &&
              (T = T.next =
                {
                  lane: 0,
                  revertLane: 0,
                  action: C.action,
                  hasEagerState: C.hasEagerState,
                  eagerState: C.eagerState,
                  next: null,
                }),
              Y === zi && (B = !0);
          else if ((Mn & N) === N) {
            (C = C.next), N === zi && (B = !0);
            continue;
          } else
            (Y = {
              lane: 0,
              revertLane: C.revertLane,
              action: C.action,
              hasEagerState: C.hasEagerState,
              eagerState: C.eagerState,
              next: null,
            }),
              T === null ? ((v = T = Y), (h = u)) : (T = T.next = Y),
              (ct.lanes |= N),
              (wn |= N);
          (Y = C.action),
            ai && n(u, Y),
            (u = C.hasEagerState ? C.eagerState : n(u, Y));
        } else
          (N = {
            lane: Y,
            revertLane: C.revertLane,
            action: C.action,
            hasEagerState: C.hasEagerState,
            eagerState: C.eagerState,
            next: null,
          }),
            T === null ? ((v = T = N), (h = u)) : (T = T.next = N),
            (ct.lanes |= Y),
            (wn |= Y);
        C = C.next;
      } while (C !== null && C !== e);
      if (
        (T === null ? (h = u) : (T.next = v),
        !ge(u, t.memoizedState) && ((Qt = !0), B && ((n = Ui), n !== null)))
      )
        throw n;
      (t.memoizedState = u),
        (t.baseState = h),
        (t.baseQueue = T),
        (s.lastRenderedState = u);
    }
    return o === null && (s.lanes = 0), [t.memoizedState, s.dispatch];
  }
  function qo(t) {
    var e = Yt(),
      n = e.queue;
    if (n === null) throw Error(l(311));
    n.lastRenderedReducer = t;
    var s = n.dispatch,
      o = n.pending,
      u = e.memoizedState;
    if (o !== null) {
      n.pending = null;
      var h = (o = o.next);
      do (u = t(u, h.action)), (h = h.next);
      while (h !== o);
      ge(u, e.memoizedState) || (Qt = !0),
        (e.memoizedState = u),
        e.baseQueue === null && (e.baseState = u),
        (n.lastRenderedState = u);
    }
    return [u, s];
  }
  function Bd(t, e, n) {
    var s = ct,
      o = Yt(),
      u = xt;
    if (u) {
      if (n === void 0) throw Error(l(407));
      n = n();
    } else n = e();
    var h = !ge((At || o).memoizedState, n);
    h && ((o.memoizedState = n), (Qt = !0)), (o = o.queue);
    var v = Yd.bind(null, s, o, t);
    if (
      (Ya(2048, 8, v, [t]),
      o.getSnapshot !== e || h || (Gt !== null && Gt.memoizedState.tag & 1))
    ) {
      if (
        ((s.flags |= 2048),
        Yi(9, ml(), Gd.bind(null, s, o, n, e), null),
        jt === null)
      )
        throw Error(l(349));
      u || (Mn & 124) !== 0 || Hd(s, e, n);
    }
    return n;
  }
  function Hd(t, e, n) {
    (t.flags |= 16384),
      (t = { getSnapshot: e, value: n }),
      (e = ct.updateQueue),
      e === null
        ? ((e = Ho()), (ct.updateQueue = e), (e.stores = [t]))
        : ((n = e.stores), n === null ? (e.stores = [t]) : n.push(t));
  }
  function Gd(t, e, n, s) {
    (e.value = n), (e.getSnapshot = s), qd(e) && Xd(t);
  }
  function Yd(t, e, n) {
    return n(function () {
      qd(e) && Xd(t);
    });
  }
  function qd(t) {
    var e = t.getSnapshot;
    t = t.value;
    try {
      var n = e();
      return !ge(t, n);
    } catch {
      return !0;
    }
  }
  function Xd(t) {
    var e = wi(t, 2);
    e !== null && Ee(e, t, 2);
  }
  function Xo(t) {
    var e = fe();
    if (typeof t == "function") {
      var n = t;
      if (((t = n()), ai)) {
        vn(!0);
        try {
          n();
        } finally {
          vn(!1);
        }
      }
    }
    return (
      (e.memoizedState = e.baseState = t),
      (e.queue = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: ln,
        lastRenderedState: t,
      }),
      e
    );
  }
  function kd(t, e, n, s) {
    return (t.baseState = n), Yo(t, At, typeof s == "function" ? s : ln);
  }
  function e1(t, e, n, s, o) {
    if (yl(t)) throw Error(l(485));
    if (((t = e.action), t !== null)) {
      var u = {
        payload: o,
        action: t,
        next: null,
        isTransition: !0,
        status: "pending",
        value: null,
        reason: null,
        listeners: [],
        then: function (h) {
          u.listeners.push(h);
        },
      };
      z.T !== null ? n(!0) : (u.isTransition = !1),
        s(u),
        (n = e.pending),
        n === null
          ? ((u.next = e.pending = u), Zd(e, u))
          : ((u.next = n.next), (e.pending = n.next = u));
    }
  }
  function Zd(t, e) {
    var n = e.action,
      s = e.payload,
      o = t.state;
    if (e.isTransition) {
      var u = z.T,
        h = {};
      z.T = h;
      try {
        var v = n(o, s),
          T = z.S;
        T !== null && T(h, v), Kd(t, e, v);
      } catch (C) {
        ko(t, e, C);
      } finally {
        z.T = u;
      }
    } else
      try {
        (u = n(o, s)), Kd(t, e, u);
      } catch (C) {
        ko(t, e, C);
      }
  }
  function Kd(t, e, n) {
    n !== null && typeof n == "object" && typeof n.then == "function"
      ? n.then(
          function (s) {
            Pd(t, e, s);
          },
          function (s) {
            return ko(t, e, s);
          },
        )
      : Pd(t, e, n);
  }
  function Pd(t, e, n) {
    (e.status = "fulfilled"),
      (e.value = n),
      Qd(e),
      (t.state = n),
      (e = t.pending),
      e !== null &&
        ((n = e.next),
        n === e ? (t.pending = null) : ((n = n.next), (e.next = n), Zd(t, n)));
  }
  function ko(t, e, n) {
    var s = t.pending;
    if (((t.pending = null), s !== null)) {
      s = s.next;
      do (e.status = "rejected"), (e.reason = n), Qd(e), (e = e.next);
      while (e !== s);
    }
    t.action = null;
  }
  function Qd(t) {
    t = t.listeners;
    for (var e = 0; e < t.length; e++) (0, t[e])();
  }
  function Jd(t, e) {
    return e;
  }
  function Fd(t, e) {
    if (xt) {
      var n = jt.formState;
      if (n !== null) {
        t: {
          var s = ct;
          if (xt) {
            if (Lt) {
              e: {
                for (var o = Lt, u = Xe; o.nodeType !== 8; ) {
                  if (!u) {
                    o = null;
                    break e;
                  }
                  if (((o = Be(o.nextSibling)), o === null)) {
                    o = null;
                    break e;
                  }
                }
                (u = o.data), (o = u === "F!" || u === "F" ? o : null);
              }
              if (o) {
                (Lt = Be(o.nextSibling)), (s = o.data === "F!");
                break t;
              }
            }
            ti(s);
          }
          s = !1;
        }
        s && (e = n[0]);
      }
    }
    return (
      (n = fe()),
      (n.memoizedState = n.baseState = e),
      (s = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Jd,
        lastRenderedState: e,
      }),
      (n.queue = s),
      (n = ph.bind(null, ct, s)),
      (s.dispatch = n),
      (s = Xo(!1)),
      (u = Jo.bind(null, ct, !1, s.queue)),
      (s = fe()),
      (o = { state: e, dispatch: null, action: t, pending: null }),
      (s.queue = o),
      (n = e1.bind(null, ct, o, u, n)),
      (o.dispatch = n),
      (s.memoizedState = t),
      [e, n, !1]
    );
  }
  function $d(t) {
    var e = Yt();
    return Wd(e, At, t);
  }
  function Wd(t, e, n) {
    if (
      ((e = Yo(t, e, Jd)[0]),
      (t = hl(ln)[0]),
      typeof e == "object" && e !== null && typeof e.then == "function")
    )
      try {
        var s = Ga(e);
      } catch (h) {
        throw h === _a ? rl : h;
      }
    else s = e;
    e = Yt();
    var o = e.queue,
      u = o.dispatch;
    return (
      n !== e.memoizedState &&
        ((ct.flags |= 2048), Yi(9, ml(), n1.bind(null, o, n), null)),
      [s, u, t]
    );
  }
  function n1(t, e) {
    t.action = e;
  }
  function Id(t) {
    var e = Yt(),
      n = At;
    if (n !== null) return Wd(e, n, t);
    Yt(), (e = e.memoizedState), (n = Yt());
    var s = n.queue.dispatch;
    return (n.memoizedState = t), [e, s, !1];
  }
  function Yi(t, e, n, s) {
    return (
      (t = { tag: t, create: n, deps: s, inst: e, next: null }),
      (e = ct.updateQueue),
      e === null && ((e = Ho()), (ct.updateQueue = e)),
      (n = e.lastEffect),
      n === null
        ? (e.lastEffect = t.next = t)
        : ((s = n.next), (n.next = t), (t.next = s), (e.lastEffect = t)),
      t
    );
  }
  function ml() {
    return { destroy: void 0, resource: void 0 };
  }
  function th() {
    return Yt().memoizedState;
  }
  function pl(t, e, n, s) {
    var o = fe();
    (s = s === void 0 ? null : s),
      (ct.flags |= t),
      (o.memoizedState = Yi(1 | e, ml(), n, s));
  }
  function Ya(t, e, n, s) {
    var o = Yt();
    s = s === void 0 ? null : s;
    var u = o.memoizedState.inst;
    At !== null && s !== null && _o(s, At.memoizedState.deps)
      ? (o.memoizedState = Yi(e, u, n, s))
      : ((ct.flags |= t), (o.memoizedState = Yi(1 | e, u, n, s)));
  }
  function eh(t, e) {
    pl(8390656, 8, t, e);
  }
  function nh(t, e) {
    Ya(2048, 8, t, e);
  }
  function ih(t, e) {
    return Ya(4, 2, t, e);
  }
  function ah(t, e) {
    return Ya(4, 4, t, e);
  }
  function sh(t, e) {
    if (typeof e == "function") {
      t = t();
      var n = e(t);
      return function () {
        typeof n == "function" ? n() : e(null);
      };
    }
    if (e != null)
      return (
        (t = t()),
        (e.current = t),
        function () {
          e.current = null;
        }
      );
  }
  function lh(t, e, n) {
    (n = n != null ? n.concat([t]) : null), Ya(4, 4, sh.bind(null, e, t), n);
  }
  function Zo() {}
  function rh(t, e) {
    var n = Yt();
    e = e === void 0 ? null : e;
    var s = n.memoizedState;
    return e !== null && _o(e, s[1]) ? s[0] : ((n.memoizedState = [t, e]), t);
  }
  function oh(t, e) {
    var n = Yt();
    e = e === void 0 ? null : e;
    var s = n.memoizedState;
    if (e !== null && _o(e, s[1])) return s[0];
    if (((s = t()), ai)) {
      vn(!0);
      try {
        t();
      } finally {
        vn(!1);
      }
    }
    return (n.memoizedState = [s, e]), s;
  }
  function Ko(t, e, n) {
    return n === void 0 || (Mn & 1073741824) !== 0
      ? (t.memoizedState = e)
      : ((t.memoizedState = n), (t = fm()), (ct.lanes |= t), (wn |= t), n);
  }
  function uh(t, e, n, s) {
    return ge(n, e)
      ? n
      : Bi.current !== null
        ? ((t = Ko(t, n, s)), ge(t, e) || (Qt = !0), t)
        : (Mn & 42) === 0
          ? ((Qt = !0), (t.memoizedState = n))
          : ((t = fm()), (ct.lanes |= t), (wn |= t), e);
  }
  function ch(t, e, n, s, o) {
    var u = Z.p;
    Z.p = u !== 0 && 8 > u ? u : 8;
    var h = z.T,
      v = {};
    (z.T = v), Jo(t, !1, e, n);
    try {
      var T = o(),
        C = z.S;
      if (
        (C !== null && C(v, T),
        T !== null && typeof T == "object" && typeof T.then == "function")
      ) {
        var B = Wv(T, s);
        qa(t, e, B, Te(t));
      } else qa(t, e, s, Te(t));
    } catch (Y) {
      qa(t, e, { then: function () {}, status: "rejected", reason: Y }, Te());
    } finally {
      (Z.p = u), (z.T = h);
    }
  }
  function i1() {}
  function Po(t, e, n, s) {
    if (t.tag !== 5) throw Error(l(476));
    var o = fh(t).queue;
    ch(
      t,
      o,
      e,
      J,
      n === null
        ? i1
        : function () {
            return dh(t), n(s);
          },
    );
  }
  function fh(t) {
    var e = t.memoizedState;
    if (e !== null) return e;
    e = {
      memoizedState: J,
      baseState: J,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: ln,
        lastRenderedState: J,
      },
      next: null,
    };
    var n = {};
    return (
      (e.next = {
        memoizedState: n,
        baseState: n,
        baseQueue: null,
        queue: {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: ln,
          lastRenderedState: n,
        },
        next: null,
      }),
      (t.memoizedState = e),
      (t = t.alternate),
      t !== null && (t.memoizedState = e),
      e
    );
  }
  function dh(t) {
    var e = fh(t).next.queue;
    qa(t, e, {}, Te());
  }
  function Qo() {
    return ae(ls);
  }
  function hh() {
    return Yt().memoizedState;
  }
  function mh() {
    return Yt().memoizedState;
  }
  function a1(t) {
    for (var e = t.return; e !== null; ) {
      switch (e.tag) {
        case 24:
        case 3:
          var n = Te();
          t = En(n);
          var s = An(e, t, n);
          s !== null && (Ee(s, e, n), za(s, e, n)),
            (e = { cache: Ao() }),
            (t.payload = e);
          return;
      }
      e = e.return;
    }
  }
  function s1(t, e, n) {
    var s = Te();
    (n = {
      lane: s,
      revertLane: 0,
      action: n,
      hasEagerState: !1,
      eagerState: null,
      next: null,
    }),
      yl(t)
        ? yh(e, n)
        : ((n = mo(t, e, n, s)), n !== null && (Ee(n, t, s), gh(n, e, s)));
  }
  function ph(t, e, n) {
    var s = Te();
    qa(t, e, n, s);
  }
  function qa(t, e, n, s) {
    var o = {
      lane: s,
      revertLane: 0,
      action: n,
      hasEagerState: !1,
      eagerState: null,
      next: null,
    };
    if (yl(t)) yh(e, o);
    else {
      var u = t.alternate;
      if (
        t.lanes === 0 &&
        (u === null || u.lanes === 0) &&
        ((u = e.lastRenderedReducer), u !== null)
      )
        try {
          var h = e.lastRenderedState,
            v = u(h, n);
          if (((o.hasEagerState = !0), (o.eagerState = v), ge(v, h)))
            return Is(t, e, o, 0), jt === null && Ws(), !1;
        } catch {}
      if (((n = mo(t, e, o, s)), n !== null))
        return Ee(n, t, s), gh(n, e, s), !0;
    }
    return !1;
  }
  function Jo(t, e, n, s) {
    if (
      ((s = {
        lane: 2,
        revertLane: Du(),
        action: s,
        hasEagerState: !1,
        eagerState: null,
        next: null,
      }),
      yl(t))
    ) {
      if (e) throw Error(l(479));
    } else (e = mo(t, n, s, 2)), e !== null && Ee(e, t, 2);
  }
  function yl(t) {
    var e = t.alternate;
    return t === ct || (e !== null && e === ct);
  }
  function yh(t, e) {
    Hi = cl = !0;
    var n = t.pending;
    n === null ? (e.next = e) : ((e.next = n.next), (n.next = e)),
      (t.pending = e);
  }
  function gh(t, e, n) {
    if ((n & 4194048) !== 0) {
      var s = e.lanes;
      (s &= t.pendingLanes), (n |= s), (e.lanes = n), Mf(t, n);
    }
  }
  var gl = {
      readContext: ae,
      use: dl,
      useCallback: Bt,
      useContext: Bt,
      useEffect: Bt,
      useImperativeHandle: Bt,
      useLayoutEffect: Bt,
      useInsertionEffect: Bt,
      useMemo: Bt,
      useReducer: Bt,
      useRef: Bt,
      useState: Bt,
      useDebugValue: Bt,
      useDeferredValue: Bt,
      useTransition: Bt,
      useSyncExternalStore: Bt,
      useId: Bt,
      useHostTransitionStatus: Bt,
      useFormState: Bt,
      useActionState: Bt,
      useOptimistic: Bt,
      useMemoCache: Bt,
      useCacheRefresh: Bt,
    },
    vh = {
      readContext: ae,
      use: dl,
      useCallback: function (t, e) {
        return (fe().memoizedState = [t, e === void 0 ? null : e]), t;
      },
      useContext: ae,
      useEffect: eh,
      useImperativeHandle: function (t, e, n) {
        (n = n != null ? n.concat([t]) : null),
          pl(4194308, 4, sh.bind(null, e, t), n);
      },
      useLayoutEffect: function (t, e) {
        return pl(4194308, 4, t, e);
      },
      useInsertionEffect: function (t, e) {
        pl(4, 2, t, e);
      },
      useMemo: function (t, e) {
        var n = fe();
        e = e === void 0 ? null : e;
        var s = t();
        if (ai) {
          vn(!0);
          try {
            t();
          } finally {
            vn(!1);
          }
        }
        return (n.memoizedState = [s, e]), s;
      },
      useReducer: function (t, e, n) {
        var s = fe();
        if (n !== void 0) {
          var o = n(e);
          if (ai) {
            vn(!0);
            try {
              n(e);
            } finally {
              vn(!1);
            }
          }
        } else o = e;
        return (
          (s.memoizedState = s.baseState = o),
          (t = {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: t,
            lastRenderedState: o,
          }),
          (s.queue = t),
          (t = t.dispatch = s1.bind(null, ct, t)),
          [s.memoizedState, t]
        );
      },
      useRef: function (t) {
        var e = fe();
        return (t = { current: t }), (e.memoizedState = t);
      },
      useState: function (t) {
        t = Xo(t);
        var e = t.queue,
          n = ph.bind(null, ct, e);
        return (e.dispatch = n), [t.memoizedState, n];
      },
      useDebugValue: Zo,
      useDeferredValue: function (t, e) {
        var n = fe();
        return Ko(n, t, e);
      },
      useTransition: function () {
        var t = Xo(!1);
        return (
          (t = ch.bind(null, ct, t.queue, !0, !1)),
          (fe().memoizedState = t),
          [!1, t]
        );
      },
      useSyncExternalStore: function (t, e, n) {
        var s = ct,
          o = fe();
        if (xt) {
          if (n === void 0) throw Error(l(407));
          n = n();
        } else {
          if (((n = e()), jt === null)) throw Error(l(349));
          (yt & 124) !== 0 || Hd(s, e, n);
        }
        o.memoizedState = n;
        var u = { value: n, getSnapshot: e };
        return (
          (o.queue = u),
          eh(Yd.bind(null, s, u, t), [t]),
          (s.flags |= 2048),
          Yi(9, ml(), Gd.bind(null, s, u, n, e), null),
          n
        );
      },
      useId: function () {
        var t = fe(),
          e = jt.identifierPrefix;
        if (xt) {
          var n = nn,
            s = en;
          (n = (s & ~(1 << (32 - ye(s) - 1))).toString(32) + n),
            (e = "«" + e + "R" + n),
            (n = fl++),
            0 < n && (e += "H" + n.toString(32)),
            (e += "»");
        } else (n = Iv++), (e = "«" + e + "r" + n.toString(32) + "»");
        return (t.memoizedState = e);
      },
      useHostTransitionStatus: Qo,
      useFormState: Fd,
      useActionState: Fd,
      useOptimistic: function (t) {
        var e = fe();
        e.memoizedState = e.baseState = t;
        var n = {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: null,
          lastRenderedState: null,
        };
        return (
          (e.queue = n),
          (e = Jo.bind(null, ct, !0, n)),
          (n.dispatch = e),
          [t, e]
        );
      },
      useMemoCache: Go,
      useCacheRefresh: function () {
        return (fe().memoizedState = a1.bind(null, ct));
      },
    },
    Sh = {
      readContext: ae,
      use: dl,
      useCallback: rh,
      useContext: ae,
      useEffect: nh,
      useImperativeHandle: lh,
      useInsertionEffect: ih,
      useLayoutEffect: ah,
      useMemo: oh,
      useReducer: hl,
      useRef: th,
      useState: function () {
        return hl(ln);
      },
      useDebugValue: Zo,
      useDeferredValue: function (t, e) {
        var n = Yt();
        return uh(n, At.memoizedState, t, e);
      },
      useTransition: function () {
        var t = hl(ln)[0],
          e = Yt().memoizedState;
        return [typeof t == "boolean" ? t : Ga(t), e];
      },
      useSyncExternalStore: Bd,
      useId: hh,
      useHostTransitionStatus: Qo,
      useFormState: $d,
      useActionState: $d,
      useOptimistic: function (t, e) {
        var n = Yt();
        return kd(n, At, t, e);
      },
      useMemoCache: Go,
      useCacheRefresh: mh,
    },
    l1 = {
      readContext: ae,
      use: dl,
      useCallback: rh,
      useContext: ae,
      useEffect: nh,
      useImperativeHandle: lh,
      useInsertionEffect: ih,
      useLayoutEffect: ah,
      useMemo: oh,
      useReducer: qo,
      useRef: th,
      useState: function () {
        return qo(ln);
      },
      useDebugValue: Zo,
      useDeferredValue: function (t, e) {
        var n = Yt();
        return At === null ? Ko(n, t, e) : uh(n, At.memoizedState, t, e);
      },
      useTransition: function () {
        var t = qo(ln)[0],
          e = Yt().memoizedState;
        return [typeof t == "boolean" ? t : Ga(t), e];
      },
      useSyncExternalStore: Bd,
      useId: hh,
      useHostTransitionStatus: Qo,
      useFormState: Id,
      useActionState: Id,
      useOptimistic: function (t, e) {
        var n = Yt();
        return At !== null
          ? kd(n, At, t, e)
          : ((n.baseState = t), [t, n.queue.dispatch]);
      },
      useMemoCache: Go,
      useCacheRefresh: mh,
    },
    qi = null,
    Xa = 0;
  function vl(t) {
    var e = Xa;
    return (Xa += 1), qi === null && (qi = []), jd(qi, t, e);
  }
  function ka(t, e) {
    (e = e.props.ref), (t.ref = e !== void 0 ? e : null);
  }
  function Sl(t, e) {
    throw e.$$typeof === x
      ? Error(l(525))
      : ((t = Object.prototype.toString.call(e)),
        Error(
          l(
            31,
            t === "[object Object]"
              ? "object with keys {" + Object.keys(e).join(", ") + "}"
              : t,
          ),
        ));
  }
  function xh(t) {
    var e = t._init;
    return e(t._payload);
  }
  function bh(t) {
    function e(D, M) {
      if (t) {
        var O = D.deletions;
        O === null ? ((D.deletions = [M]), (D.flags |= 16)) : O.push(M);
      }
    }
    function n(D, M) {
      if (!t) return null;
      for (; M !== null; ) e(D, M), (M = M.sibling);
      return null;
    }
    function s(D) {
      for (var M = new Map(); D !== null; )
        D.key !== null ? M.set(D.key, D) : M.set(D.index, D), (D = D.sibling);
      return M;
    }
    function o(D, M) {
      return (D = tn(D, M)), (D.index = 0), (D.sibling = null), D;
    }
    function u(D, M, O) {
      return (
        (D.index = O),
        t
          ? ((O = D.alternate),
            O !== null
              ? ((O = O.index), O < M ? ((D.flags |= 67108866), M) : O)
              : ((D.flags |= 67108866), M))
          : ((D.flags |= 1048576), M)
      );
    }
    function h(D) {
      return t && D.alternate === null && (D.flags |= 67108866), D;
    }
    function v(D, M, O, G) {
      return M === null || M.tag !== 6
        ? ((M = yo(O, D.mode, G)), (M.return = D), M)
        : ((M = o(M, O)), (M.return = D), M);
    }
    function T(D, M, O, G) {
      var F = O.type;
      return F === A
        ? B(D, M, O.props.children, G, O.key)
        : M !== null &&
            (M.elementType === F ||
              (typeof F == "object" &&
                F !== null &&
                F.$$typeof === P &&
                xh(F) === M.type))
          ? ((M = o(M, O.props)), ka(M, O), (M.return = D), M)
          : ((M = el(O.type, O.key, O.props, null, D.mode, G)),
            ka(M, O),
            (M.return = D),
            M);
    }
    function C(D, M, O, G) {
      return M === null ||
        M.tag !== 4 ||
        M.stateNode.containerInfo !== O.containerInfo ||
        M.stateNode.implementation !== O.implementation
        ? ((M = go(O, D.mode, G)), (M.return = D), M)
        : ((M = o(M, O.children || [])), (M.return = D), M);
    }
    function B(D, M, O, G, F) {
      return M === null || M.tag !== 7
        ? ((M = Fn(O, D.mode, G, F)), (M.return = D), M)
        : ((M = o(M, O)), (M.return = D), M);
    }
    function Y(D, M, O) {
      if (
        (typeof M == "string" && M !== "") ||
        typeof M == "number" ||
        typeof M == "bigint"
      )
        return (M = yo("" + M, D.mode, O)), (M.return = D), M;
      if (typeof M == "object" && M !== null) {
        switch (M.$$typeof) {
          case b:
            return (
              (O = el(M.type, M.key, M.props, null, D.mode, O)),
              ka(O, M),
              (O.return = D),
              O
            );
          case j:
            return (M = go(M, D.mode, O)), (M.return = D), M;
          case P:
            var G = M._init;
            return (M = G(M._payload)), Y(D, M, O);
        }
        if (Ct(M) || pt(M))
          return (M = Fn(M, D.mode, O, null)), (M.return = D), M;
        if (typeof M.then == "function") return Y(D, vl(M), O);
        if (M.$$typeof === H) return Y(D, sl(D, M), O);
        Sl(D, M);
      }
      return null;
    }
    function N(D, M, O, G) {
      var F = M !== null ? M.key : null;
      if (
        (typeof O == "string" && O !== "") ||
        typeof O == "number" ||
        typeof O == "bigint"
      )
        return F !== null ? null : v(D, M, "" + O, G);
      if (typeof O == "object" && O !== null) {
        switch (O.$$typeof) {
          case b:
            return O.key === F ? T(D, M, O, G) : null;
          case j:
            return O.key === F ? C(D, M, O, G) : null;
          case P:
            return (F = O._init), (O = F(O._payload)), N(D, M, O, G);
        }
        if (Ct(O) || pt(O)) return F !== null ? null : B(D, M, O, G, null);
        if (typeof O.then == "function") return N(D, M, vl(O), G);
        if (O.$$typeof === H) return N(D, M, sl(D, O), G);
        Sl(D, O);
      }
      return null;
    }
    function w(D, M, O, G, F) {
      if (
        (typeof G == "string" && G !== "") ||
        typeof G == "number" ||
        typeof G == "bigint"
      )
        return (D = D.get(O) || null), v(M, D, "" + G, F);
      if (typeof G == "object" && G !== null) {
        switch (G.$$typeof) {
          case b:
            return (
              (D = D.get(G.key === null ? O : G.key) || null), T(M, D, G, F)
            );
          case j:
            return (
              (D = D.get(G.key === null ? O : G.key) || null), C(M, D, G, F)
            );
          case P:
            var ft = G._init;
            return (G = ft(G._payload)), w(D, M, O, G, F);
        }
        if (Ct(G) || pt(G)) return (D = D.get(O) || null), B(M, D, G, F, null);
        if (typeof G.then == "function") return w(D, M, O, vl(G), F);
        if (G.$$typeof === H) return w(D, M, O, sl(M, G), F);
        Sl(M, G);
      }
      return null;
    }
    function st(D, M, O, G) {
      for (
        var F = null, ft = null, I = M, at = (M = 0), Ft = null;
        I !== null && at < O.length;
        at++
      ) {
        I.index > at ? ((Ft = I), (I = null)) : (Ft = I.sibling);
        var vt = N(D, I, O[at], G);
        if (vt === null) {
          I === null && (I = Ft);
          break;
        }
        t && I && vt.alternate === null && e(D, I),
          (M = u(vt, M, at)),
          ft === null ? (F = vt) : (ft.sibling = vt),
          (ft = vt),
          (I = Ft);
      }
      if (at === O.length) return n(D, I), xt && Wn(D, at), F;
      if (I === null) {
        for (; at < O.length; at++)
          (I = Y(D, O[at], G)),
            I !== null &&
              ((M = u(I, M, at)),
              ft === null ? (F = I) : (ft.sibling = I),
              (ft = I));
        return xt && Wn(D, at), F;
      }
      for (I = s(I); at < O.length; at++)
        (Ft = w(I, D, at, O[at], G)),
          Ft !== null &&
            (t &&
              Ft.alternate !== null &&
              I.delete(Ft.key === null ? at : Ft.key),
            (M = u(Ft, M, at)),
            ft === null ? (F = Ft) : (ft.sibling = Ft),
            (ft = Ft));
      return (
        t &&
          I.forEach(function (Yn) {
            return e(D, Yn);
          }),
        xt && Wn(D, at),
        F
      );
    }
    function it(D, M, O, G) {
      if (O == null) throw Error(l(151));
      for (
        var F = null, ft = null, I = M, at = (M = 0), Ft = null, vt = O.next();
        I !== null && !vt.done;
        at++, vt = O.next()
      ) {
        I.index > at ? ((Ft = I), (I = null)) : (Ft = I.sibling);
        var Yn = N(D, I, vt.value, G);
        if (Yn === null) {
          I === null && (I = Ft);
          break;
        }
        t && I && Yn.alternate === null && e(D, I),
          (M = u(Yn, M, at)),
          ft === null ? (F = Yn) : (ft.sibling = Yn),
          (ft = Yn),
          (I = Ft);
      }
      if (vt.done) return n(D, I), xt && Wn(D, at), F;
      if (I === null) {
        for (; !vt.done; at++, vt = O.next())
          (vt = Y(D, vt.value, G)),
            vt !== null &&
              ((M = u(vt, M, at)),
              ft === null ? (F = vt) : (ft.sibling = vt),
              (ft = vt));
        return xt && Wn(D, at), F;
      }
      for (I = s(I); !vt.done; at++, vt = O.next())
        (vt = w(I, D, at, vt.value, G)),
          vt !== null &&
            (t &&
              vt.alternate !== null &&
              I.delete(vt.key === null ? at : vt.key),
            (M = u(vt, M, at)),
            ft === null ? (F = vt) : (ft.sibling = vt),
            (ft = vt));
      return (
        t &&
          I.forEach(function (rS) {
            return e(D, rS);
          }),
        xt && Wn(D, at),
        F
      );
    }
    function Rt(D, M, O, G) {
      if (
        (typeof O == "object" &&
          O !== null &&
          O.type === A &&
          O.key === null &&
          (O = O.props.children),
        typeof O == "object" && O !== null)
      ) {
        switch (O.$$typeof) {
          case b:
            t: {
              for (var F = O.key; M !== null; ) {
                if (M.key === F) {
                  if (((F = O.type), F === A)) {
                    if (M.tag === 7) {
                      n(D, M.sibling),
                        (G = o(M, O.props.children)),
                        (G.return = D),
                        (D = G);
                      break t;
                    }
                  } else if (
                    M.elementType === F ||
                    (typeof F == "object" &&
                      F !== null &&
                      F.$$typeof === P &&
                      xh(F) === M.type)
                  ) {
                    n(D, M.sibling),
                      (G = o(M, O.props)),
                      ka(G, O),
                      (G.return = D),
                      (D = G);
                    break t;
                  }
                  n(D, M);
                  break;
                } else e(D, M);
                M = M.sibling;
              }
              O.type === A
                ? ((G = Fn(O.props.children, D.mode, G, O.key)),
                  (G.return = D),
                  (D = G))
                : ((G = el(O.type, O.key, O.props, null, D.mode, G)),
                  ka(G, O),
                  (G.return = D),
                  (D = G));
            }
            return h(D);
          case j:
            t: {
              for (F = O.key; M !== null; ) {
                if (M.key === F)
                  if (
                    M.tag === 4 &&
                    M.stateNode.containerInfo === O.containerInfo &&
                    M.stateNode.implementation === O.implementation
                  ) {
                    n(D, M.sibling),
                      (G = o(M, O.children || [])),
                      (G.return = D),
                      (D = G);
                    break t;
                  } else {
                    n(D, M);
                    break;
                  }
                else e(D, M);
                M = M.sibling;
              }
              (G = go(O, D.mode, G)), (G.return = D), (D = G);
            }
            return h(D);
          case P:
            return (F = O._init), (O = F(O._payload)), Rt(D, M, O, G);
        }
        if (Ct(O)) return st(D, M, O, G);
        if (pt(O)) {
          if (((F = pt(O)), typeof F != "function")) throw Error(l(150));
          return (O = F.call(O)), it(D, M, O, G);
        }
        if (typeof O.then == "function") return Rt(D, M, vl(O), G);
        if (O.$$typeof === H) return Rt(D, M, sl(D, O), G);
        Sl(D, O);
      }
      return (typeof O == "string" && O !== "") ||
        typeof O == "number" ||
        typeof O == "bigint"
        ? ((O = "" + O),
          M !== null && M.tag === 6
            ? (n(D, M.sibling), (G = o(M, O)), (G.return = D), (D = G))
            : (n(D, M), (G = yo(O, D.mode, G)), (G.return = D), (D = G)),
          h(D))
        : n(D, M);
    }
    return function (D, M, O, G) {
      try {
        Xa = 0;
        var F = Rt(D, M, O, G);
        return (qi = null), F;
      } catch (I) {
        if (I === _a || I === rl) throw I;
        var ft = ve(29, I, null, D.mode);
        return (ft.lanes = G), (ft.return = D), ft;
      }
    };
  }
  var Xi = bh(!0),
    Th = bh(!1),
    Ne = q(null),
    ke = null;
  function Rn(t) {
    var e = t.alternate;
    K(kt, kt.current & 1),
      K(Ne, t),
      ke === null &&
        (e === null || Bi.current !== null || e.memoizedState !== null) &&
        (ke = t);
  }
  function Eh(t) {
    if (t.tag === 22) {
      if ((K(kt, kt.current), K(Ne, t), ke === null)) {
        var e = t.alternate;
        e !== null && e.memoizedState !== null && (ke = t);
      }
    } else Dn();
  }
  function Dn() {
    K(kt, kt.current), K(Ne, Ne.current);
  }
  function rn(t) {
    Q(Ne), ke === t && (ke = null), Q(kt);
  }
  var kt = q(0);
  function xl(t) {
    for (var e = t; e !== null; ) {
      if (e.tag === 13) {
        var n = e.memoizedState;
        if (
          n !== null &&
          ((n = n.dehydrated), n === null || n.data === "$?" || Hu(n))
        )
          return e;
      } else if (e.tag === 19 && e.memoizedProps.revealOrder !== void 0) {
        if ((e.flags & 128) !== 0) return e;
      } else if (e.child !== null) {
        (e.child.return = e), (e = e.child);
        continue;
      }
      if (e === t) break;
      for (; e.sibling === null; ) {
        if (e.return === null || e.return === t) return null;
        e = e.return;
      }
      (e.sibling.return = e.return), (e = e.sibling);
    }
    return null;
  }
  function Fo(t, e, n, s) {
    (e = t.memoizedState),
      (n = n(s, e)),
      (n = n == null ? e : g({}, e, n)),
      (t.memoizedState = n),
      t.lanes === 0 && (t.updateQueue.baseState = n);
  }
  var $o = {
    enqueueSetState: function (t, e, n) {
      t = t._reactInternals;
      var s = Te(),
        o = En(s);
      (o.payload = e),
        n != null && (o.callback = n),
        (e = An(t, o, s)),
        e !== null && (Ee(e, t, s), za(e, t, s));
    },
    enqueueReplaceState: function (t, e, n) {
      t = t._reactInternals;
      var s = Te(),
        o = En(s);
      (o.tag = 1),
        (o.payload = e),
        n != null && (o.callback = n),
        (e = An(t, o, s)),
        e !== null && (Ee(e, t, s), za(e, t, s));
    },
    enqueueForceUpdate: function (t, e) {
      t = t._reactInternals;
      var n = Te(),
        s = En(n);
      (s.tag = 2),
        e != null && (s.callback = e),
        (e = An(t, s, n)),
        e !== null && (Ee(e, t, n), za(e, t, n));
    },
  };
  function Ah(t, e, n, s, o, u, h) {
    return (
      (t = t.stateNode),
      typeof t.shouldComponentUpdate == "function"
        ? t.shouldComponentUpdate(s, u, h)
        : e.prototype && e.prototype.isPureReactComponent
          ? !Ra(n, s) || !Ra(o, u)
          : !0
    );
  }
  function Mh(t, e, n, s) {
    (t = e.state),
      typeof e.componentWillReceiveProps == "function" &&
        e.componentWillReceiveProps(n, s),
      typeof e.UNSAFE_componentWillReceiveProps == "function" &&
        e.UNSAFE_componentWillReceiveProps(n, s),
      e.state !== t && $o.enqueueReplaceState(e, e.state, null);
  }
  function si(t, e) {
    var n = e;
    if ("ref" in e) {
      n = {};
      for (var s in e) s !== "ref" && (n[s] = e[s]);
    }
    if ((t = t.defaultProps)) {
      n === e && (n = g({}, n));
      for (var o in t) n[o] === void 0 && (n[o] = t[o]);
    }
    return n;
  }
  var bl =
    typeof reportError == "function"
      ? reportError
      : function (t) {
          if (
            typeof window == "object" &&
            typeof window.ErrorEvent == "function"
          ) {
            var e = new window.ErrorEvent("error", {
              bubbles: !0,
              cancelable: !0,
              message:
                typeof t == "object" &&
                t !== null &&
                typeof t.message == "string"
                  ? String(t.message)
                  : String(t),
              error: t,
            });
            if (!window.dispatchEvent(e)) return;
          } else if (
            typeof process == "object" &&
            typeof process.emit == "function"
          ) {
            process.emit("uncaughtException", t);
            return;
          }
          console.error(t);
        };
  function Rh(t) {
    bl(t);
  }
  function Dh(t) {
    console.error(t);
  }
  function Oh(t) {
    bl(t);
  }
  function Tl(t, e) {
    try {
      var n = t.onUncaughtError;
      n(e.value, { componentStack: e.stack });
    } catch (s) {
      setTimeout(function () {
        throw s;
      });
    }
  }
  function Ch(t, e, n) {
    try {
      var s = t.onCaughtError;
      s(n.value, {
        componentStack: n.stack,
        errorBoundary: e.tag === 1 ? e.stateNode : null,
      });
    } catch (o) {
      setTimeout(function () {
        throw o;
      });
    }
  }
  function Wo(t, e, n) {
    return (
      (n = En(n)),
      (n.tag = 3),
      (n.payload = { element: null }),
      (n.callback = function () {
        Tl(t, e);
      }),
      n
    );
  }
  function jh(t) {
    return (t = En(t)), (t.tag = 3), t;
  }
  function Nh(t, e, n, s) {
    var o = n.type.getDerivedStateFromError;
    if (typeof o == "function") {
      var u = s.value;
      (t.payload = function () {
        return o(u);
      }),
        (t.callback = function () {
          Ch(e, n, s);
        });
    }
    var h = n.stateNode;
    h !== null &&
      typeof h.componentDidCatch == "function" &&
      (t.callback = function () {
        Ch(e, n, s),
          typeof o != "function" &&
            (Vn === null ? (Vn = new Set([this])) : Vn.add(this));
        var v = s.stack;
        this.componentDidCatch(s.value, {
          componentStack: v !== null ? v : "",
        });
      });
  }
  function r1(t, e, n, s, o) {
    if (
      ((n.flags |= 32768),
      s !== null && typeof s == "object" && typeof s.then == "function")
    ) {
      if (
        ((e = n.alternate),
        e !== null && Na(e, n, o, !0),
        (n = Ne.current),
        n !== null)
      ) {
        switch (n.tag) {
          case 13:
            return (
              ke === null ? Tu() : n.alternate === null && zt === 0 && (zt = 3),
              (n.flags &= -257),
              (n.flags |= 65536),
              (n.lanes = o),
              s === Do
                ? (n.flags |= 16384)
                : ((e = n.updateQueue),
                  e === null ? (n.updateQueue = new Set([s])) : e.add(s),
                  Au(t, s, o)),
              !1
            );
          case 22:
            return (
              (n.flags |= 65536),
              s === Do
                ? (n.flags |= 16384)
                : ((e = n.updateQueue),
                  e === null
                    ? ((e = {
                        transitions: null,
                        markerInstances: null,
                        retryQueue: new Set([s]),
                      }),
                      (n.updateQueue = e))
                    : ((n = e.retryQueue),
                      n === null ? (e.retryQueue = new Set([s])) : n.add(s)),
                  Au(t, s, o)),
              !1
            );
        }
        throw Error(l(435, n.tag));
      }
      return Au(t, s, o), Tu(), !1;
    }
    if (xt)
      return (
        (e = Ne.current),
        e !== null
          ? ((e.flags & 65536) === 0 && (e.flags |= 256),
            (e.flags |= 65536),
            (e.lanes = o),
            s !== xo && ((t = Error(l(422), { cause: s })), ja(De(t, n))))
          : (s !== xo && ((e = Error(l(423), { cause: s })), ja(De(e, n))),
            (t = t.current.alternate),
            (t.flags |= 65536),
            (o &= -o),
            (t.lanes |= o),
            (s = De(s, n)),
            (o = Wo(t.stateNode, s, o)),
            jo(t, o),
            zt !== 4 && (zt = 2)),
        !1
      );
    var u = Error(l(520), { cause: s });
    if (
      ((u = De(u, n)),
      $a === null ? ($a = [u]) : $a.push(u),
      zt !== 4 && (zt = 2),
      e === null)
    )
      return !0;
    (s = De(s, n)), (n = e);
    do {
      switch (n.tag) {
        case 3:
          return (
            (n.flags |= 65536),
            (t = o & -o),
            (n.lanes |= t),
            (t = Wo(n.stateNode, s, t)),
            jo(n, t),
            !1
          );
        case 1:
          if (
            ((e = n.type),
            (u = n.stateNode),
            (n.flags & 128) === 0 &&
              (typeof e.getDerivedStateFromError == "function" ||
                (u !== null &&
                  typeof u.componentDidCatch == "function" &&
                  (Vn === null || !Vn.has(u)))))
          )
            return (
              (n.flags |= 65536),
              (o &= -o),
              (n.lanes |= o),
              (o = jh(o)),
              Nh(o, t, n, s),
              jo(n, o),
              !1
            );
      }
      n = n.return;
    } while (n !== null);
    return !1;
  }
  var wh = Error(l(461)),
    Qt = !1;
  function Wt(t, e, n, s) {
    e.child = t === null ? Th(e, null, n, s) : Xi(e, t.child, n, s);
  }
  function Vh(t, e, n, s, o) {
    n = n.render;
    var u = e.ref;
    if ("ref" in s) {
      var h = {};
      for (var v in s) v !== "ref" && (h[v] = s[v]);
    } else h = s;
    return (
      ni(e),
      (s = Lo(t, e, n, h, u, o)),
      (v = zo()),
      t !== null && !Qt
        ? (Uo(t, e, o), on(t, e, o))
        : (xt && v && vo(e), (e.flags |= 1), Wt(t, e, s, o), e.child)
    );
  }
  function _h(t, e, n, s, o) {
    if (t === null) {
      var u = n.type;
      return typeof u == "function" &&
        !po(u) &&
        u.defaultProps === void 0 &&
        n.compare === null
        ? ((e.tag = 15), (e.type = u), Lh(t, e, u, s, o))
        : ((t = el(n.type, null, s, e, e.mode, o)),
          (t.ref = e.ref),
          (t.return = e),
          (e.child = t));
    }
    if (((u = t.child), !lu(t, o))) {
      var h = u.memoizedProps;
      if (
        ((n = n.compare), (n = n !== null ? n : Ra), n(h, s) && t.ref === e.ref)
      )
        return on(t, e, o);
    }
    return (
      (e.flags |= 1),
      (t = tn(u, s)),
      (t.ref = e.ref),
      (t.return = e),
      (e.child = t)
    );
  }
  function Lh(t, e, n, s, o) {
    if (t !== null) {
      var u = t.memoizedProps;
      if (Ra(u, s) && t.ref === e.ref)
        if (((Qt = !1), (e.pendingProps = s = u), lu(t, o)))
          (t.flags & 131072) !== 0 && (Qt = !0);
        else return (e.lanes = t.lanes), on(t, e, o);
    }
    return Io(t, e, n, s, o);
  }
  function zh(t, e, n) {
    var s = e.pendingProps,
      o = s.children,
      u = t !== null ? t.memoizedState : null;
    if (s.mode === "hidden") {
      if ((e.flags & 128) !== 0) {
        if (((s = u !== null ? u.baseLanes | n : n), t !== null)) {
          for (o = e.child = t.child, u = 0; o !== null; )
            (u = u | o.lanes | o.childLanes), (o = o.sibling);
          e.childLanes = u & ~s;
        } else (e.childLanes = 0), (e.child = null);
        return Uh(t, e, s, n);
      }
      if ((n & 536870912) !== 0)
        (e.memoizedState = { baseLanes: 0, cachePool: null }),
          t !== null && ll(e, u !== null ? u.cachePool : null),
          u !== null ? Ld(e, u) : wo(),
          Eh(e);
      else
        return (
          (e.lanes = e.childLanes = 536870912),
          Uh(t, e, u !== null ? u.baseLanes | n : n, n)
        );
    } else
      u !== null
        ? (ll(e, u.cachePool), Ld(e, u), Dn(), (e.memoizedState = null))
        : (t !== null && ll(e, null), wo(), Dn());
    return Wt(t, e, o, n), e.child;
  }
  function Uh(t, e, n, s) {
    var o = Ro();
    return (
      (o = o === null ? null : { parent: Xt._currentValue, pool: o }),
      (e.memoizedState = { baseLanes: n, cachePool: o }),
      t !== null && ll(e, null),
      wo(),
      Eh(e),
      t !== null && Na(t, e, s, !0),
      null
    );
  }
  function El(t, e) {
    var n = e.ref;
    if (n === null) t !== null && t.ref !== null && (e.flags |= 4194816);
    else {
      if (typeof n != "function" && typeof n != "object") throw Error(l(284));
      (t === null || t.ref !== n) && (e.flags |= 4194816);
    }
  }
  function Io(t, e, n, s, o) {
    return (
      ni(e),
      (n = Lo(t, e, n, s, void 0, o)),
      (s = zo()),
      t !== null && !Qt
        ? (Uo(t, e, o), on(t, e, o))
        : (xt && s && vo(e), (e.flags |= 1), Wt(t, e, n, o), e.child)
    );
  }
  function Bh(t, e, n, s, o, u) {
    return (
      ni(e),
      (e.updateQueue = null),
      (n = Ud(e, s, n, o)),
      zd(t),
      (s = zo()),
      t !== null && !Qt
        ? (Uo(t, e, u), on(t, e, u))
        : (xt && s && vo(e), (e.flags |= 1), Wt(t, e, n, u), e.child)
    );
  }
  function Hh(t, e, n, s, o) {
    if ((ni(e), e.stateNode === null)) {
      var u = Vi,
        h = n.contextType;
      typeof h == "object" && h !== null && (u = ae(h)),
        (u = new n(s, u)),
        (e.memoizedState =
          u.state !== null && u.state !== void 0 ? u.state : null),
        (u.updater = $o),
        (e.stateNode = u),
        (u._reactInternals = e),
        (u = e.stateNode),
        (u.props = s),
        (u.state = e.memoizedState),
        (u.refs = {}),
        Oo(e),
        (h = n.contextType),
        (u.context = typeof h == "object" && h !== null ? ae(h) : Vi),
        (u.state = e.memoizedState),
        (h = n.getDerivedStateFromProps),
        typeof h == "function" && (Fo(e, n, h, s), (u.state = e.memoizedState)),
        typeof n.getDerivedStateFromProps == "function" ||
          typeof u.getSnapshotBeforeUpdate == "function" ||
          (typeof u.UNSAFE_componentWillMount != "function" &&
            typeof u.componentWillMount != "function") ||
          ((h = u.state),
          typeof u.componentWillMount == "function" && u.componentWillMount(),
          typeof u.UNSAFE_componentWillMount == "function" &&
            u.UNSAFE_componentWillMount(),
          h !== u.state && $o.enqueueReplaceState(u, u.state, null),
          Ba(e, s, u, o),
          Ua(),
          (u.state = e.memoizedState)),
        typeof u.componentDidMount == "function" && (e.flags |= 4194308),
        (s = !0);
    } else if (t === null) {
      u = e.stateNode;
      var v = e.memoizedProps,
        T = si(n, v);
      u.props = T;
      var C = u.context,
        B = n.contextType;
      (h = Vi), typeof B == "object" && B !== null && (h = ae(B));
      var Y = n.getDerivedStateFromProps;
      (B =
        typeof Y == "function" ||
        typeof u.getSnapshotBeforeUpdate == "function"),
        (v = e.pendingProps !== v),
        B ||
          (typeof u.UNSAFE_componentWillReceiveProps != "function" &&
            typeof u.componentWillReceiveProps != "function") ||
          ((v || C !== h) && Mh(e, u, s, h)),
        (Tn = !1);
      var N = e.memoizedState;
      (u.state = N),
        Ba(e, s, u, o),
        Ua(),
        (C = e.memoizedState),
        v || N !== C || Tn
          ? (typeof Y == "function" && (Fo(e, n, Y, s), (C = e.memoizedState)),
            (T = Tn || Ah(e, n, T, s, N, C, h))
              ? (B ||
                  (typeof u.UNSAFE_componentWillMount != "function" &&
                    typeof u.componentWillMount != "function") ||
                  (typeof u.componentWillMount == "function" &&
                    u.componentWillMount(),
                  typeof u.UNSAFE_componentWillMount == "function" &&
                    u.UNSAFE_componentWillMount()),
                typeof u.componentDidMount == "function" &&
                  (e.flags |= 4194308))
              : (typeof u.componentDidMount == "function" &&
                  (e.flags |= 4194308),
                (e.memoizedProps = s),
                (e.memoizedState = C)),
            (u.props = s),
            (u.state = C),
            (u.context = h),
            (s = T))
          : (typeof u.componentDidMount == "function" && (e.flags |= 4194308),
            (s = !1));
    } else {
      (u = e.stateNode),
        Co(t, e),
        (h = e.memoizedProps),
        (B = si(n, h)),
        (u.props = B),
        (Y = e.pendingProps),
        (N = u.context),
        (C = n.contextType),
        (T = Vi),
        typeof C == "object" && C !== null && (T = ae(C)),
        (v = n.getDerivedStateFromProps),
        (C =
          typeof v == "function" ||
          typeof u.getSnapshotBeforeUpdate == "function") ||
          (typeof u.UNSAFE_componentWillReceiveProps != "function" &&
            typeof u.componentWillReceiveProps != "function") ||
          ((h !== Y || N !== T) && Mh(e, u, s, T)),
        (Tn = !1),
        (N = e.memoizedState),
        (u.state = N),
        Ba(e, s, u, o),
        Ua();
      var w = e.memoizedState;
      h !== Y ||
      N !== w ||
      Tn ||
      (t !== null && t.dependencies !== null && al(t.dependencies))
        ? (typeof v == "function" && (Fo(e, n, v, s), (w = e.memoizedState)),
          (B =
            Tn ||
            Ah(e, n, B, s, N, w, T) ||
            (t !== null && t.dependencies !== null && al(t.dependencies)))
            ? (C ||
                (typeof u.UNSAFE_componentWillUpdate != "function" &&
                  typeof u.componentWillUpdate != "function") ||
                (typeof u.componentWillUpdate == "function" &&
                  u.componentWillUpdate(s, w, T),
                typeof u.UNSAFE_componentWillUpdate == "function" &&
                  u.UNSAFE_componentWillUpdate(s, w, T)),
              typeof u.componentDidUpdate == "function" && (e.flags |= 4),
              typeof u.getSnapshotBeforeUpdate == "function" &&
                (e.flags |= 1024))
            : (typeof u.componentDidUpdate != "function" ||
                (h === t.memoizedProps && N === t.memoizedState) ||
                (e.flags |= 4),
              typeof u.getSnapshotBeforeUpdate != "function" ||
                (h === t.memoizedProps && N === t.memoizedState) ||
                (e.flags |= 1024),
              (e.memoizedProps = s),
              (e.memoizedState = w)),
          (u.props = s),
          (u.state = w),
          (u.context = T),
          (s = B))
        : (typeof u.componentDidUpdate != "function" ||
            (h === t.memoizedProps && N === t.memoizedState) ||
            (e.flags |= 4),
          typeof u.getSnapshotBeforeUpdate != "function" ||
            (h === t.memoizedProps && N === t.memoizedState) ||
            (e.flags |= 1024),
          (s = !1));
    }
    return (
      (u = s),
      El(t, e),
      (s = (e.flags & 128) !== 0),
      u || s
        ? ((u = e.stateNode),
          (n =
            s && typeof n.getDerivedStateFromError != "function"
              ? null
              : u.render()),
          (e.flags |= 1),
          t !== null && s
            ? ((e.child = Xi(e, t.child, null, o)),
              (e.child = Xi(e, null, n, o)))
            : Wt(t, e, n, o),
          (e.memoizedState = u.state),
          (t = e.child))
        : (t = on(t, e, o)),
      t
    );
  }
  function Gh(t, e, n, s) {
    return Ca(), (e.flags |= 256), Wt(t, e, n, s), e.child;
  }
  var tu = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null,
  };
  function eu(t) {
    return { baseLanes: t, cachePool: Dd() };
  }
  function nu(t, e, n) {
    return (t = t !== null ? t.childLanes & ~n : 0), e && (t |= we), t;
  }
  function Yh(t, e, n) {
    var s = e.pendingProps,
      o = !1,
      u = (e.flags & 128) !== 0,
      h;
    if (
      ((h = u) ||
        (h =
          t !== null && t.memoizedState === null ? !1 : (kt.current & 2) !== 0),
      h && ((o = !0), (e.flags &= -129)),
      (h = (e.flags & 32) !== 0),
      (e.flags &= -33),
      t === null)
    ) {
      if (xt) {
        if ((o ? Rn(e) : Dn(), xt)) {
          var v = Lt,
            T;
          if ((T = v)) {
            t: {
              for (T = v, v = Xe; T.nodeType !== 8; ) {
                if (!v) {
                  v = null;
                  break t;
                }
                if (((T = Be(T.nextSibling)), T === null)) {
                  v = null;
                  break t;
                }
              }
              v = T;
            }
            v !== null
              ? ((e.memoizedState = {
                  dehydrated: v,
                  treeContext: $n !== null ? { id: en, overflow: nn } : null,
                  retryLane: 536870912,
                  hydrationErrors: null,
                }),
                (T = ve(18, null, null, 0)),
                (T.stateNode = v),
                (T.return = e),
                (e.child = T),
                (le = e),
                (Lt = null),
                (T = !0))
              : (T = !1);
          }
          T || ti(e);
        }
        if (
          ((v = e.memoizedState),
          v !== null && ((v = v.dehydrated), v !== null))
        )
          return Hu(v) ? (e.lanes = 32) : (e.lanes = 536870912), null;
        rn(e);
      }
      return (
        (v = s.children),
        (s = s.fallback),
        o
          ? (Dn(),
            (o = e.mode),
            (v = Al({ mode: "hidden", children: v }, o)),
            (s = Fn(s, o, n, null)),
            (v.return = e),
            (s.return = e),
            (v.sibling = s),
            (e.child = v),
            (o = e.child),
            (o.memoizedState = eu(n)),
            (o.childLanes = nu(t, h, n)),
            (e.memoizedState = tu),
            s)
          : (Rn(e), iu(e, v))
      );
    }
    if (
      ((T = t.memoizedState), T !== null && ((v = T.dehydrated), v !== null))
    ) {
      if (u)
        e.flags & 256
          ? (Rn(e), (e.flags &= -257), (e = au(t, e, n)))
          : e.memoizedState !== null
            ? (Dn(), (e.child = t.child), (e.flags |= 128), (e = null))
            : (Dn(),
              (o = s.fallback),
              (v = e.mode),
              (s = Al({ mode: "visible", children: s.children }, v)),
              (o = Fn(o, v, n, null)),
              (o.flags |= 2),
              (s.return = e),
              (o.return = e),
              (s.sibling = o),
              (e.child = s),
              Xi(e, t.child, null, n),
              (s = e.child),
              (s.memoizedState = eu(n)),
              (s.childLanes = nu(t, h, n)),
              (e.memoizedState = tu),
              (e = o));
      else if ((Rn(e), Hu(v))) {
        if (((h = v.nextSibling && v.nextSibling.dataset), h)) var C = h.dgst;
        (h = C),
          (s = Error(l(419))),
          (s.stack = ""),
          (s.digest = h),
          ja({ value: s, source: null, stack: null }),
          (e = au(t, e, n));
      } else if (
        (Qt || Na(t, e, n, !1), (h = (n & t.childLanes) !== 0), Qt || h)
      ) {
        if (
          ((h = jt),
          h !== null &&
            ((s = n & -n),
            (s = (s & 42) !== 0 ? 1 : Hr(s)),
            (s = (s & (h.suspendedLanes | n)) !== 0 ? 0 : s),
            s !== 0 && s !== T.retryLane))
        )
          throw ((T.retryLane = s), wi(t, s), Ee(h, t, s), wh);
        v.data === "$?" || Tu(), (e = au(t, e, n));
      } else
        v.data === "$?"
          ? ((e.flags |= 192), (e.child = t.child), (e = null))
          : ((t = T.treeContext),
            (Lt = Be(v.nextSibling)),
            (le = e),
            (xt = !0),
            (In = null),
            (Xe = !1),
            t !== null &&
              ((Ce[je++] = en),
              (Ce[je++] = nn),
              (Ce[je++] = $n),
              (en = t.id),
              (nn = t.overflow),
              ($n = e)),
            (e = iu(e, s.children)),
            (e.flags |= 4096));
      return e;
    }
    return o
      ? (Dn(),
        (o = s.fallback),
        (v = e.mode),
        (T = t.child),
        (C = T.sibling),
        (s = tn(T, { mode: "hidden", children: s.children })),
        (s.subtreeFlags = T.subtreeFlags & 65011712),
        C !== null ? (o = tn(C, o)) : ((o = Fn(o, v, n, null)), (o.flags |= 2)),
        (o.return = e),
        (s.return = e),
        (s.sibling = o),
        (e.child = s),
        (s = o),
        (o = e.child),
        (v = t.child.memoizedState),
        v === null
          ? (v = eu(n))
          : ((T = v.cachePool),
            T !== null
              ? ((C = Xt._currentValue),
                (T = T.parent !== C ? { parent: C, pool: C } : T))
              : (T = Dd()),
            (v = { baseLanes: v.baseLanes | n, cachePool: T })),
        (o.memoizedState = v),
        (o.childLanes = nu(t, h, n)),
        (e.memoizedState = tu),
        s)
      : (Rn(e),
        (n = t.child),
        (t = n.sibling),
        (n = tn(n, { mode: "visible", children: s.children })),
        (n.return = e),
        (n.sibling = null),
        t !== null &&
          ((h = e.deletions),
          h === null ? ((e.deletions = [t]), (e.flags |= 16)) : h.push(t)),
        (e.child = n),
        (e.memoizedState = null),
        n);
  }
  function iu(t, e) {
    return (
      (e = Al({ mode: "visible", children: e }, t.mode)),
      (e.return = t),
      (t.child = e)
    );
  }
  function Al(t, e) {
    return (
      (t = ve(22, t, null, e)),
      (t.lanes = 0),
      (t.stateNode = {
        _visibility: 1,
        _pendingMarkers: null,
        _retryCache: null,
        _transitions: null,
      }),
      t
    );
  }
  function au(t, e, n) {
    return (
      Xi(e, t.child, null, n),
      (t = iu(e, e.pendingProps.children)),
      (t.flags |= 2),
      (e.memoizedState = null),
      t
    );
  }
  function qh(t, e, n) {
    t.lanes |= e;
    var s = t.alternate;
    s !== null && (s.lanes |= e), To(t.return, e, n);
  }
  function su(t, e, n, s, o) {
    var u = t.memoizedState;
    u === null
      ? (t.memoizedState = {
          isBackwards: e,
          rendering: null,
          renderingStartTime: 0,
          last: s,
          tail: n,
          tailMode: o,
        })
      : ((u.isBackwards = e),
        (u.rendering = null),
        (u.renderingStartTime = 0),
        (u.last = s),
        (u.tail = n),
        (u.tailMode = o));
  }
  function Xh(t, e, n) {
    var s = e.pendingProps,
      o = s.revealOrder,
      u = s.tail;
    if ((Wt(t, e, s.children, n), (s = kt.current), (s & 2) !== 0))
      (s = (s & 1) | 2), (e.flags |= 128);
    else {
      if (t !== null && (t.flags & 128) !== 0)
        t: for (t = e.child; t !== null; ) {
          if (t.tag === 13) t.memoizedState !== null && qh(t, n, e);
          else if (t.tag === 19) qh(t, n, e);
          else if (t.child !== null) {
            (t.child.return = t), (t = t.child);
            continue;
          }
          if (t === e) break t;
          for (; t.sibling === null; ) {
            if (t.return === null || t.return === e) break t;
            t = t.return;
          }
          (t.sibling.return = t.return), (t = t.sibling);
        }
      s &= 1;
    }
    switch ((K(kt, s), o)) {
      case "forwards":
        for (n = e.child, o = null; n !== null; )
          (t = n.alternate),
            t !== null && xl(t) === null && (o = n),
            (n = n.sibling);
        (n = o),
          n === null
            ? ((o = e.child), (e.child = null))
            : ((o = n.sibling), (n.sibling = null)),
          su(e, !1, o, n, u);
        break;
      case "backwards":
        for (n = null, o = e.child, e.child = null; o !== null; ) {
          if (((t = o.alternate), t !== null && xl(t) === null)) {
            e.child = o;
            break;
          }
          (t = o.sibling), (o.sibling = n), (n = o), (o = t);
        }
        su(e, !0, n, null, u);
        break;
      case "together":
        su(e, !1, null, null, void 0);
        break;
      default:
        e.memoizedState = null;
    }
    return e.child;
  }
  function on(t, e, n) {
    if (
      (t !== null && (e.dependencies = t.dependencies),
      (wn |= e.lanes),
      (n & e.childLanes) === 0)
    )
      if (t !== null) {
        if ((Na(t, e, n, !1), (n & e.childLanes) === 0)) return null;
      } else return null;
    if (t !== null && e.child !== t.child) throw Error(l(153));
    if (e.child !== null) {
      for (
        t = e.child, n = tn(t, t.pendingProps), e.child = n, n.return = e;
        t.sibling !== null;
      )
        (t = t.sibling),
          (n = n.sibling = tn(t, t.pendingProps)),
          (n.return = e);
      n.sibling = null;
    }
    return e.child;
  }
  function lu(t, e) {
    return (t.lanes & e) !== 0
      ? !0
      : ((t = t.dependencies), !!(t !== null && al(t)));
  }
  function o1(t, e, n) {
    switch (e.tag) {
      case 3:
        wt(e, e.stateNode.containerInfo),
          bn(e, Xt, t.memoizedState.cache),
          Ca();
        break;
      case 27:
      case 5:
        _r(e);
        break;
      case 4:
        wt(e, e.stateNode.containerInfo);
        break;
      case 10:
        bn(e, e.type, e.memoizedProps.value);
        break;
      case 13:
        var s = e.memoizedState;
        if (s !== null)
          return s.dehydrated !== null
            ? (Rn(e), (e.flags |= 128), null)
            : (n & e.child.childLanes) !== 0
              ? Yh(t, e, n)
              : (Rn(e), (t = on(t, e, n)), t !== null ? t.sibling : null);
        Rn(e);
        break;
      case 19:
        var o = (t.flags & 128) !== 0;
        if (
          ((s = (n & e.childLanes) !== 0),
          s || (Na(t, e, n, !1), (s = (n & e.childLanes) !== 0)),
          o)
        ) {
          if (s) return Xh(t, e, n);
          e.flags |= 128;
        }
        if (
          ((o = e.memoizedState),
          o !== null &&
            ((o.rendering = null), (o.tail = null), (o.lastEffect = null)),
          K(kt, kt.current),
          s)
        )
          break;
        return null;
      case 22:
      case 23:
        return (e.lanes = 0), zh(t, e, n);
      case 24:
        bn(e, Xt, t.memoizedState.cache);
    }
    return on(t, e, n);
  }
  function kh(t, e, n) {
    if (t !== null)
      if (t.memoizedProps !== e.pendingProps) Qt = !0;
      else {
        if (!lu(t, n) && (e.flags & 128) === 0) return (Qt = !1), o1(t, e, n);
        Qt = (t.flags & 131072) !== 0;
      }
    else (Qt = !1), xt && (e.flags & 1048576) !== 0 && xd(e, il, e.index);
    switch (((e.lanes = 0), e.tag)) {
      case 16:
        t: {
          t = e.pendingProps;
          var s = e.elementType,
            o = s._init;
          if (((s = o(s._payload)), (e.type = s), typeof s == "function"))
            po(s)
              ? ((t = si(s, t)), (e.tag = 1), (e = Hh(null, e, s, t, n)))
              : ((e.tag = 0), (e = Io(null, e, s, t, n)));
          else {
            if (s != null) {
              if (((o = s.$$typeof), o === X)) {
                (e.tag = 11), (e = Vh(null, e, s, t, n));
                break t;
              } else if (o === et) {
                (e.tag = 14), (e = _h(null, e, s, t, n));
                break t;
              }
            }
            throw ((e = Kt(s) || s), Error(l(306, e, "")));
          }
        }
        return e;
      case 0:
        return Io(t, e, e.type, e.pendingProps, n);
      case 1:
        return (s = e.type), (o = si(s, e.pendingProps)), Hh(t, e, s, o, n);
      case 3:
        t: {
          if ((wt(e, e.stateNode.containerInfo), t === null))
            throw Error(l(387));
          s = e.pendingProps;
          var u = e.memoizedState;
          (o = u.element), Co(t, e), Ba(e, s, null, n);
          var h = e.memoizedState;
          if (
            ((s = h.cache),
            bn(e, Xt, s),
            s !== u.cache && Eo(e, [Xt], n, !0),
            Ua(),
            (s = h.element),
            u.isDehydrated)
          )
            if (
              ((u = { element: s, isDehydrated: !1, cache: h.cache }),
              (e.updateQueue.baseState = u),
              (e.memoizedState = u),
              e.flags & 256)
            ) {
              e = Gh(t, e, s, n);
              break t;
            } else if (s !== o) {
              (o = De(Error(l(424)), e)), ja(o), (e = Gh(t, e, s, n));
              break t;
            } else
              for (
                t = e.stateNode.containerInfo,
                  t.nodeType === 9
                    ? (t = t.body)
                    : (t = t.nodeName === "HTML" ? t.ownerDocument.body : t),
                  Lt = Be(t.firstChild),
                  le = e,
                  xt = !0,
                  In = null,
                  Xe = !0,
                  n = Th(e, null, s, n),
                  e.child = n;
                n;
              )
                (n.flags = (n.flags & -3) | 4096), (n = n.sibling);
          else {
            if ((Ca(), s === o)) {
              e = on(t, e, n);
              break t;
            }
            Wt(t, e, s, n);
          }
          e = e.child;
        }
        return e;
      case 26:
        return (
          El(t, e),
          t === null
            ? (n = Qm(e.type, null, e.pendingProps, null))
              ? (e.memoizedState = n)
              : xt ||
                ((n = e.type),
                (t = e.pendingProps),
                (s = Bl(rt.current).createElement(n)),
                (s[ie] = e),
                (s[ue] = t),
                te(s, n, t),
                Pt(s),
                (e.stateNode = s))
            : (e.memoizedState = Qm(
                e.type,
                t.memoizedProps,
                e.pendingProps,
                t.memoizedState,
              )),
          null
        );
      case 27:
        return (
          _r(e),
          t === null &&
            xt &&
            ((s = e.stateNode = Zm(e.type, e.pendingProps, rt.current)),
            (le = e),
            (Xe = !0),
            (o = Lt),
            zn(e.type) ? ((Gu = o), (Lt = Be(s.firstChild))) : (Lt = o)),
          Wt(t, e, e.pendingProps.children, n),
          El(t, e),
          t === null && (e.flags |= 4194304),
          e.child
        );
      case 5:
        return (
          t === null &&
            xt &&
            ((o = s = Lt) &&
              ((s = z1(s, e.type, e.pendingProps, Xe)),
              s !== null
                ? ((e.stateNode = s),
                  (le = e),
                  (Lt = Be(s.firstChild)),
                  (Xe = !1),
                  (o = !0))
                : (o = !1)),
            o || ti(e)),
          _r(e),
          (o = e.type),
          (u = e.pendingProps),
          (h = t !== null ? t.memoizedProps : null),
          (s = u.children),
          zu(o, u) ? (s = null) : h !== null && zu(o, h) && (e.flags |= 32),
          e.memoizedState !== null &&
            ((o = Lo(t, e, t1, null, null, n)), (ls._currentValue = o)),
          El(t, e),
          Wt(t, e, s, n),
          e.child
        );
      case 6:
        return (
          t === null &&
            xt &&
            ((t = n = Lt) &&
              ((n = U1(n, e.pendingProps, Xe)),
              n !== null
                ? ((e.stateNode = n), (le = e), (Lt = null), (t = !0))
                : (t = !1)),
            t || ti(e)),
          null
        );
      case 13:
        return Yh(t, e, n);
      case 4:
        return (
          wt(e, e.stateNode.containerInfo),
          (s = e.pendingProps),
          t === null ? (e.child = Xi(e, null, s, n)) : Wt(t, e, s, n),
          e.child
        );
      case 11:
        return Vh(t, e, e.type, e.pendingProps, n);
      case 7:
        return Wt(t, e, e.pendingProps, n), e.child;
      case 8:
        return Wt(t, e, e.pendingProps.children, n), e.child;
      case 12:
        return Wt(t, e, e.pendingProps.children, n), e.child;
      case 10:
        return (
          (s = e.pendingProps),
          bn(e, e.type, s.value),
          Wt(t, e, s.children, n),
          e.child
        );
      case 9:
        return (
          (o = e.type._context),
          (s = e.pendingProps.children),
          ni(e),
          (o = ae(o)),
          (s = s(o)),
          (e.flags |= 1),
          Wt(t, e, s, n),
          e.child
        );
      case 14:
        return _h(t, e, e.type, e.pendingProps, n);
      case 15:
        return Lh(t, e, e.type, e.pendingProps, n);
      case 19:
        return Xh(t, e, n);
      case 31:
        return (
          (s = e.pendingProps),
          (n = e.mode),
          (s = { mode: s.mode, children: s.children }),
          t === null
            ? ((n = Al(s, n)),
              (n.ref = e.ref),
              (e.child = n),
              (n.return = e),
              (e = n))
            : ((n = tn(t.child, s)),
              (n.ref = e.ref),
              (e.child = n),
              (n.return = e),
              (e = n)),
          e
        );
      case 22:
        return zh(t, e, n);
      case 24:
        return (
          ni(e),
          (s = ae(Xt)),
          t === null
            ? ((o = Ro()),
              o === null &&
                ((o = jt),
                (u = Ao()),
                (o.pooledCache = u),
                u.refCount++,
                u !== null && (o.pooledCacheLanes |= n),
                (o = u)),
              (e.memoizedState = { parent: s, cache: o }),
              Oo(e),
              bn(e, Xt, o))
            : ((t.lanes & n) !== 0 && (Co(t, e), Ba(e, null, null, n), Ua()),
              (o = t.memoizedState),
              (u = e.memoizedState),
              o.parent !== s
                ? ((o = { parent: s, cache: s }),
                  (e.memoizedState = o),
                  e.lanes === 0 &&
                    (e.memoizedState = e.updateQueue.baseState = o),
                  bn(e, Xt, s))
                : ((s = u.cache),
                  bn(e, Xt, s),
                  s !== o.cache && Eo(e, [Xt], n, !0))),
          Wt(t, e, e.pendingProps.children, n),
          e.child
        );
      case 29:
        throw e.pendingProps;
    }
    throw Error(l(156, e.tag));
  }
  function un(t) {
    t.flags |= 4;
  }
  function Zh(t, e) {
    if (e.type !== "stylesheet" || (e.state.loading & 4) !== 0)
      t.flags &= -16777217;
    else if (((t.flags |= 16777216), !Im(e))) {
      if (
        ((e = Ne.current),
        e !== null &&
          ((yt & 4194048) === yt
            ? ke !== null
            : ((yt & 62914560) !== yt && (yt & 536870912) === 0) || e !== ke))
      )
        throw ((La = Do), Od);
      t.flags |= 8192;
    }
  }
  function Ml(t, e) {
    e !== null && (t.flags |= 4),
      t.flags & 16384 &&
        ((e = t.tag !== 22 ? Ef() : 536870912), (t.lanes |= e), (Pi |= e));
  }
  function Za(t, e) {
    if (!xt)
      switch (t.tailMode) {
        case "hidden":
          e = t.tail;
          for (var n = null; e !== null; )
            e.alternate !== null && (n = e), (e = e.sibling);
          n === null ? (t.tail = null) : (n.sibling = null);
          break;
        case "collapsed":
          n = t.tail;
          for (var s = null; n !== null; )
            n.alternate !== null && (s = n), (n = n.sibling);
          s === null
            ? e || t.tail === null
              ? (t.tail = null)
              : (t.tail.sibling = null)
            : (s.sibling = null);
      }
  }
  function _t(t) {
    var e = t.alternate !== null && t.alternate.child === t.child,
      n = 0,
      s = 0;
    if (e)
      for (var o = t.child; o !== null; )
        (n |= o.lanes | o.childLanes),
          (s |= o.subtreeFlags & 65011712),
          (s |= o.flags & 65011712),
          (o.return = t),
          (o = o.sibling);
    else
      for (o = t.child; o !== null; )
        (n |= o.lanes | o.childLanes),
          (s |= o.subtreeFlags),
          (s |= o.flags),
          (o.return = t),
          (o = o.sibling);
    return (t.subtreeFlags |= s), (t.childLanes = n), e;
  }
  function u1(t, e, n) {
    var s = e.pendingProps;
    switch ((So(e), e.tag)) {
      case 31:
      case 16:
      case 15:
      case 0:
      case 11:
      case 7:
      case 8:
      case 12:
      case 9:
      case 14:
        return _t(e), null;
      case 1:
        return _t(e), null;
      case 3:
        return (
          (n = e.stateNode),
          (s = null),
          t !== null && (s = t.memoizedState.cache),
          e.memoizedState.cache !== s && (e.flags |= 2048),
          sn(Xt),
          gn(),
          n.pendingContext &&
            ((n.context = n.pendingContext), (n.pendingContext = null)),
          (t === null || t.child === null) &&
            (Oa(e)
              ? un(e)
              : t === null ||
                (t.memoizedState.isDehydrated && (e.flags & 256) === 0) ||
                ((e.flags |= 1024), Ed())),
          _t(e),
          null
        );
      case 26:
        return (
          (n = e.memoizedState),
          t === null
            ? (un(e),
              n !== null ? (_t(e), Zh(e, n)) : (_t(e), (e.flags &= -16777217)))
            : n
              ? n !== t.memoizedState
                ? (un(e), _t(e), Zh(e, n))
                : (_t(e), (e.flags &= -16777217))
              : (t.memoizedProps !== s && un(e), _t(e), (e.flags &= -16777217)),
          null
        );
      case 27:
        zs(e), (n = rt.current);
        var o = e.type;
        if (t !== null && e.stateNode != null) t.memoizedProps !== s && un(e);
        else {
          if (!s) {
            if (e.stateNode === null) throw Error(l(166));
            return _t(e), null;
          }
          (t = nt.current),
            Oa(e) ? bd(e) : ((t = Zm(o, s, n)), (e.stateNode = t), un(e));
        }
        return _t(e), null;
      case 5:
        if ((zs(e), (n = e.type), t !== null && e.stateNode != null))
          t.memoizedProps !== s && un(e);
        else {
          if (!s) {
            if (e.stateNode === null) throw Error(l(166));
            return _t(e), null;
          }
          if (((t = nt.current), Oa(e))) bd(e);
          else {
            switch (((o = Bl(rt.current)), t)) {
              case 1:
                t = o.createElementNS("http://www.w3.org/2000/svg", n);
                break;
              case 2:
                t = o.createElementNS("http://www.w3.org/1998/Math/MathML", n);
                break;
              default:
                switch (n) {
                  case "svg":
                    t = o.createElementNS("http://www.w3.org/2000/svg", n);
                    break;
                  case "math":
                    t = o.createElementNS(
                      "http://www.w3.org/1998/Math/MathML",
                      n,
                    );
                    break;
                  case "script":
                    (t = o.createElement("div")),
                      (t.innerHTML = "<script><\/script>"),
                      (t = t.removeChild(t.firstChild));
                    break;
                  case "select":
                    (t =
                      typeof s.is == "string"
                        ? o.createElement("select", { is: s.is })
                        : o.createElement("select")),
                      s.multiple
                        ? (t.multiple = !0)
                        : s.size && (t.size = s.size);
                    break;
                  default:
                    t =
                      typeof s.is == "string"
                        ? o.createElement(n, { is: s.is })
                        : o.createElement(n);
                }
            }
            (t[ie] = e), (t[ue] = s);
            t: for (o = e.child; o !== null; ) {
              if (o.tag === 5 || o.tag === 6) t.appendChild(o.stateNode);
              else if (o.tag !== 4 && o.tag !== 27 && o.child !== null) {
                (o.child.return = o), (o = o.child);
                continue;
              }
              if (o === e) break t;
              for (; o.sibling === null; ) {
                if (o.return === null || o.return === e) break t;
                o = o.return;
              }
              (o.sibling.return = o.return), (o = o.sibling);
            }
            e.stateNode = t;
            t: switch ((te(t, n, s), n)) {
              case "button":
              case "input":
              case "select":
              case "textarea":
                t = !!s.autoFocus;
                break t;
              case "img":
                t = !0;
                break t;
              default:
                t = !1;
            }
            t && un(e);
          }
        }
        return _t(e), (e.flags &= -16777217), null;
      case 6:
        if (t && e.stateNode != null) t.memoizedProps !== s && un(e);
        else {
          if (typeof s != "string" && e.stateNode === null) throw Error(l(166));
          if (((t = rt.current), Oa(e))) {
            if (
              ((t = e.stateNode),
              (n = e.memoizedProps),
              (s = null),
              (o = le),
              o !== null)
            )
              switch (o.tag) {
                case 27:
                case 5:
                  s = o.memoizedProps;
              }
            (t[ie] = e),
              (t = !!(
                t.nodeValue === n ||
                (s !== null && s.suppressHydrationWarning === !0) ||
                Bm(t.nodeValue, n)
              )),
              t || ti(e);
          } else (t = Bl(t).createTextNode(s)), (t[ie] = e), (e.stateNode = t);
        }
        return _t(e), null;
      case 13:
        if (
          ((s = e.memoizedState),
          t === null ||
            (t.memoizedState !== null && t.memoizedState.dehydrated !== null))
        ) {
          if (((o = Oa(e)), s !== null && s.dehydrated !== null)) {
            if (t === null) {
              if (!o) throw Error(l(318));
              if (
                ((o = e.memoizedState),
                (o = o !== null ? o.dehydrated : null),
                !o)
              )
                throw Error(l(317));
              o[ie] = e;
            } else
              Ca(),
                (e.flags & 128) === 0 && (e.memoizedState = null),
                (e.flags |= 4);
            _t(e), (o = !1);
          } else
            (o = Ed()),
              t !== null &&
                t.memoizedState !== null &&
                (t.memoizedState.hydrationErrors = o),
              (o = !0);
          if (!o) return e.flags & 256 ? (rn(e), e) : (rn(e), null);
        }
        if ((rn(e), (e.flags & 128) !== 0)) return (e.lanes = n), e;
        if (
          ((n = s !== null), (t = t !== null && t.memoizedState !== null), n)
        ) {
          (s = e.child),
            (o = null),
            s.alternate !== null &&
              s.alternate.memoizedState !== null &&
              s.alternate.memoizedState.cachePool !== null &&
              (o = s.alternate.memoizedState.cachePool.pool);
          var u = null;
          s.memoizedState !== null &&
            s.memoizedState.cachePool !== null &&
            (u = s.memoizedState.cachePool.pool),
            u !== o && (s.flags |= 2048);
        }
        return (
          n !== t && n && (e.child.flags |= 8192),
          Ml(e, e.updateQueue),
          _t(e),
          null
        );
      case 4:
        return gn(), t === null && Nu(e.stateNode.containerInfo), _t(e), null;
      case 10:
        return sn(e.type), _t(e), null;
      case 19:
        if ((Q(kt), (o = e.memoizedState), o === null)) return _t(e), null;
        if (((s = (e.flags & 128) !== 0), (u = o.rendering), u === null))
          if (s) Za(o, !1);
          else {
            if (zt !== 0 || (t !== null && (t.flags & 128) !== 0))
              for (t = e.child; t !== null; ) {
                if (((u = xl(t)), u !== null)) {
                  for (
                    e.flags |= 128,
                      Za(o, !1),
                      t = u.updateQueue,
                      e.updateQueue = t,
                      Ml(e, t),
                      e.subtreeFlags = 0,
                      t = n,
                      n = e.child;
                    n !== null;
                  )
                    Sd(n, t), (n = n.sibling);
                  return K(kt, (kt.current & 1) | 2), e.child;
                }
                t = t.sibling;
              }
            o.tail !== null &&
              qe() > Ol &&
              ((e.flags |= 128), (s = !0), Za(o, !1), (e.lanes = 4194304));
          }
        else {
          if (!s)
            if (((t = xl(u)), t !== null)) {
              if (
                ((e.flags |= 128),
                (s = !0),
                (t = t.updateQueue),
                (e.updateQueue = t),
                Ml(e, t),
                Za(o, !0),
                o.tail === null &&
                  o.tailMode === "hidden" &&
                  !u.alternate &&
                  !xt)
              )
                return _t(e), null;
            } else
              2 * qe() - o.renderingStartTime > Ol &&
                n !== 536870912 &&
                ((e.flags |= 128), (s = !0), Za(o, !1), (e.lanes = 4194304));
          o.isBackwards
            ? ((u.sibling = e.child), (e.child = u))
            : ((t = o.last),
              t !== null ? (t.sibling = u) : (e.child = u),
              (o.last = u));
        }
        return o.tail !== null
          ? ((e = o.tail),
            (o.rendering = e),
            (o.tail = e.sibling),
            (o.renderingStartTime = qe()),
            (e.sibling = null),
            (t = kt.current),
            K(kt, s ? (t & 1) | 2 : t & 1),
            e)
          : (_t(e), null);
      case 22:
      case 23:
        return (
          rn(e),
          Vo(),
          (s = e.memoizedState !== null),
          t !== null
            ? (t.memoizedState !== null) !== s && (e.flags |= 8192)
            : s && (e.flags |= 8192),
          s
            ? (n & 536870912) !== 0 &&
              (e.flags & 128) === 0 &&
              (_t(e), e.subtreeFlags & 6 && (e.flags |= 8192))
            : _t(e),
          (n = e.updateQueue),
          n !== null && Ml(e, n.retryQueue),
          (n = null),
          t !== null &&
            t.memoizedState !== null &&
            t.memoizedState.cachePool !== null &&
            (n = t.memoizedState.cachePool.pool),
          (s = null),
          e.memoizedState !== null &&
            e.memoizedState.cachePool !== null &&
            (s = e.memoizedState.cachePool.pool),
          s !== n && (e.flags |= 2048),
          t !== null && Q(ii),
          null
        );
      case 24:
        return (
          (n = null),
          t !== null && (n = t.memoizedState.cache),
          e.memoizedState.cache !== n && (e.flags |= 2048),
          sn(Xt),
          _t(e),
          null
        );
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(l(156, e.tag));
  }
  function c1(t, e) {
    switch ((So(e), e.tag)) {
      case 1:
        return (
          (t = e.flags), t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null
        );
      case 3:
        return (
          sn(Xt),
          gn(),
          (t = e.flags),
          (t & 65536) !== 0 && (t & 128) === 0
            ? ((e.flags = (t & -65537) | 128), e)
            : null
        );
      case 26:
      case 27:
      case 5:
        return zs(e), null;
      case 13:
        if (
          (rn(e), (t = e.memoizedState), t !== null && t.dehydrated !== null)
        ) {
          if (e.alternate === null) throw Error(l(340));
          Ca();
        }
        return (
          (t = e.flags), t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null
        );
      case 19:
        return Q(kt), null;
      case 4:
        return gn(), null;
      case 10:
        return sn(e.type), null;
      case 22:
      case 23:
        return (
          rn(e),
          Vo(),
          t !== null && Q(ii),
          (t = e.flags),
          t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null
        );
      case 24:
        return sn(Xt), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function Kh(t, e) {
    switch ((So(e), e.tag)) {
      case 3:
        sn(Xt), gn();
        break;
      case 26:
      case 27:
      case 5:
        zs(e);
        break;
      case 4:
        gn();
        break;
      case 13:
        rn(e);
        break;
      case 19:
        Q(kt);
        break;
      case 10:
        sn(e.type);
        break;
      case 22:
      case 23:
        rn(e), Vo(), t !== null && Q(ii);
        break;
      case 24:
        sn(Xt);
    }
  }
  function Ka(t, e) {
    try {
      var n = e.updateQueue,
        s = n !== null ? n.lastEffect : null;
      if (s !== null) {
        var o = s.next;
        n = o;
        do {
          if ((n.tag & t) === t) {
            s = void 0;
            var u = n.create,
              h = n.inst;
            (s = u()), (h.destroy = s);
          }
          n = n.next;
        } while (n !== o);
      }
    } catch (v) {
      Dt(e, e.return, v);
    }
  }
  function On(t, e, n) {
    try {
      var s = e.updateQueue,
        o = s !== null ? s.lastEffect : null;
      if (o !== null) {
        var u = o.next;
        s = u;
        do {
          if ((s.tag & t) === t) {
            var h = s.inst,
              v = h.destroy;
            if (v !== void 0) {
              (h.destroy = void 0), (o = e);
              var T = n,
                C = v;
              try {
                C();
              } catch (B) {
                Dt(o, T, B);
              }
            }
          }
          s = s.next;
        } while (s !== u);
      }
    } catch (B) {
      Dt(e, e.return, B);
    }
  }
  function Ph(t) {
    var e = t.updateQueue;
    if (e !== null) {
      var n = t.stateNode;
      try {
        _d(e, n);
      } catch (s) {
        Dt(t, t.return, s);
      }
    }
  }
  function Qh(t, e, n) {
    (n.props = si(t.type, t.memoizedProps)), (n.state = t.memoizedState);
    try {
      n.componentWillUnmount();
    } catch (s) {
      Dt(t, e, s);
    }
  }
  function Pa(t, e) {
    try {
      var n = t.ref;
      if (n !== null) {
        switch (t.tag) {
          case 26:
          case 27:
          case 5:
            var s = t.stateNode;
            break;
          case 30:
            s = t.stateNode;
            break;
          default:
            s = t.stateNode;
        }
        typeof n == "function" ? (t.refCleanup = n(s)) : (n.current = s);
      }
    } catch (o) {
      Dt(t, e, o);
    }
  }
  function Ze(t, e) {
    var n = t.ref,
      s = t.refCleanup;
    if (n !== null)
      if (typeof s == "function")
        try {
          s();
        } catch (o) {
          Dt(t, e, o);
        } finally {
          (t.refCleanup = null),
            (t = t.alternate),
            t != null && (t.refCleanup = null);
        }
      else if (typeof n == "function")
        try {
          n(null);
        } catch (o) {
          Dt(t, e, o);
        }
      else n.current = null;
  }
  function Jh(t) {
    var e = t.type,
      n = t.memoizedProps,
      s = t.stateNode;
    try {
      t: switch (e) {
        case "button":
        case "input":
        case "select":
        case "textarea":
          n.autoFocus && s.focus();
          break t;
        case "img":
          n.src ? (s.src = n.src) : n.srcSet && (s.srcset = n.srcSet);
      }
    } catch (o) {
      Dt(t, t.return, o);
    }
  }
  function ru(t, e, n) {
    try {
      var s = t.stateNode;
      N1(s, t.type, n, e), (s[ue] = e);
    } catch (o) {
      Dt(t, t.return, o);
    }
  }
  function Fh(t) {
    return (
      t.tag === 5 ||
      t.tag === 3 ||
      t.tag === 26 ||
      (t.tag === 27 && zn(t.type)) ||
      t.tag === 4
    );
  }
  function ou(t) {
    t: for (;;) {
      for (; t.sibling === null; ) {
        if (t.return === null || Fh(t.return)) return null;
        t = t.return;
      }
      for (
        t.sibling.return = t.return, t = t.sibling;
        t.tag !== 5 && t.tag !== 6 && t.tag !== 18;
      ) {
        if (
          (t.tag === 27 && zn(t.type)) ||
          t.flags & 2 ||
          t.child === null ||
          t.tag === 4
        )
          continue t;
        (t.child.return = t), (t = t.child);
      }
      if (!(t.flags & 2)) return t.stateNode;
    }
  }
  function uu(t, e, n) {
    var s = t.tag;
    if (s === 5 || s === 6)
      (t = t.stateNode),
        e
          ? (n.nodeType === 9
              ? n.body
              : n.nodeName === "HTML"
                ? n.ownerDocument.body
                : n
            ).insertBefore(t, e)
          : ((e =
              n.nodeType === 9
                ? n.body
                : n.nodeName === "HTML"
                  ? n.ownerDocument.body
                  : n),
            e.appendChild(t),
            (n = n._reactRootContainer),
            n != null || e.onclick !== null || (e.onclick = Ul));
    else if (
      s !== 4 &&
      (s === 27 && zn(t.type) && ((n = t.stateNode), (e = null)),
      (t = t.child),
      t !== null)
    )
      for (uu(t, e, n), t = t.sibling; t !== null; )
        uu(t, e, n), (t = t.sibling);
  }
  function Rl(t, e, n) {
    var s = t.tag;
    if (s === 5 || s === 6)
      (t = t.stateNode), e ? n.insertBefore(t, e) : n.appendChild(t);
    else if (
      s !== 4 &&
      (s === 27 && zn(t.type) && (n = t.stateNode), (t = t.child), t !== null)
    )
      for (Rl(t, e, n), t = t.sibling; t !== null; )
        Rl(t, e, n), (t = t.sibling);
  }
  function $h(t) {
    var e = t.stateNode,
      n = t.memoizedProps;
    try {
      for (var s = t.type, o = e.attributes; o.length; )
        e.removeAttributeNode(o[0]);
      te(e, s, n), (e[ie] = t), (e[ue] = n);
    } catch (u) {
      Dt(t, t.return, u);
    }
  }
  var cn = !1,
    Ht = !1,
    cu = !1,
    Wh = typeof WeakSet == "function" ? WeakSet : Set,
    Jt = null;
  function f1(t, e) {
    if (((t = t.containerInfo), (_u = kl), (t = ud(t)), ro(t))) {
      if ("selectionStart" in t)
        var n = { start: t.selectionStart, end: t.selectionEnd };
      else
        t: {
          n = ((n = t.ownerDocument) && n.defaultView) || window;
          var s = n.getSelection && n.getSelection();
          if (s && s.rangeCount !== 0) {
            n = s.anchorNode;
            var o = s.anchorOffset,
              u = s.focusNode;
            s = s.focusOffset;
            try {
              n.nodeType, u.nodeType;
            } catch {
              n = null;
              break t;
            }
            var h = 0,
              v = -1,
              T = -1,
              C = 0,
              B = 0,
              Y = t,
              N = null;
            e: for (;;) {
              for (
                var w;
                Y !== n || (o !== 0 && Y.nodeType !== 3) || (v = h + o),
                  Y !== u || (s !== 0 && Y.nodeType !== 3) || (T = h + s),
                  Y.nodeType === 3 && (h += Y.nodeValue.length),
                  (w = Y.firstChild) !== null;
              )
                (N = Y), (Y = w);
              for (;;) {
                if (Y === t) break e;
                if (
                  (N === n && ++C === o && (v = h),
                  N === u && ++B === s && (T = h),
                  (w = Y.nextSibling) !== null)
                )
                  break;
                (Y = N), (N = Y.parentNode);
              }
              Y = w;
            }
            n = v === -1 || T === -1 ? null : { start: v, end: T };
          } else n = null;
        }
      n = n || { start: 0, end: 0 };
    } else n = null;
    for (
      Lu = { focusedElem: t, selectionRange: n }, kl = !1, Jt = e;
      Jt !== null;
    )
      if (
        ((e = Jt), (t = e.child), (e.subtreeFlags & 1024) !== 0 && t !== null)
      )
        (t.return = e), (Jt = t);
      else
        for (; Jt !== null; ) {
          switch (((e = Jt), (u = e.alternate), (t = e.flags), e.tag)) {
            case 0:
              break;
            case 11:
            case 15:
              break;
            case 1:
              if ((t & 1024) !== 0 && u !== null) {
                (t = void 0),
                  (n = e),
                  (o = u.memoizedProps),
                  (u = u.memoizedState),
                  (s = n.stateNode);
                try {
                  var st = si(n.type, o, n.elementType === n.type);
                  (t = s.getSnapshotBeforeUpdate(st, u)),
                    (s.__reactInternalSnapshotBeforeUpdate = t);
                } catch (it) {
                  Dt(n, n.return, it);
                }
              }
              break;
            case 3:
              if ((t & 1024) !== 0) {
                if (
                  ((t = e.stateNode.containerInfo), (n = t.nodeType), n === 9)
                )
                  Bu(t);
                else if (n === 1)
                  switch (t.nodeName) {
                    case "HEAD":
                    case "HTML":
                    case "BODY":
                      Bu(t);
                      break;
                    default:
                      t.textContent = "";
                  }
              }
              break;
            case 5:
            case 26:
            case 27:
            case 6:
            case 4:
            case 17:
              break;
            default:
              if ((t & 1024) !== 0) throw Error(l(163));
          }
          if (((t = e.sibling), t !== null)) {
            (t.return = e.return), (Jt = t);
            break;
          }
          Jt = e.return;
        }
  }
  function Ih(t, e, n) {
    var s = n.flags;
    switch (n.tag) {
      case 0:
      case 11:
      case 15:
        Cn(t, n), s & 4 && Ka(5, n);
        break;
      case 1:
        if ((Cn(t, n), s & 4))
          if (((t = n.stateNode), e === null))
            try {
              t.componentDidMount();
            } catch (h) {
              Dt(n, n.return, h);
            }
          else {
            var o = si(n.type, e.memoizedProps);
            e = e.memoizedState;
            try {
              t.componentDidUpdate(o, e, t.__reactInternalSnapshotBeforeUpdate);
            } catch (h) {
              Dt(n, n.return, h);
            }
          }
        s & 64 && Ph(n), s & 512 && Pa(n, n.return);
        break;
      case 3:
        if ((Cn(t, n), s & 64 && ((t = n.updateQueue), t !== null))) {
          if (((e = null), n.child !== null))
            switch (n.child.tag) {
              case 27:
              case 5:
                e = n.child.stateNode;
                break;
              case 1:
                e = n.child.stateNode;
            }
          try {
            _d(t, e);
          } catch (h) {
            Dt(n, n.return, h);
          }
        }
        break;
      case 27:
        e === null && s & 4 && $h(n);
      case 26:
      case 5:
        Cn(t, n), e === null && s & 4 && Jh(n), s & 512 && Pa(n, n.return);
        break;
      case 12:
        Cn(t, n);
        break;
      case 13:
        Cn(t, n),
          s & 4 && nm(t, n),
          s & 64 &&
            ((t = n.memoizedState),
            t !== null &&
              ((t = t.dehydrated),
              t !== null && ((n = x1.bind(null, n)), B1(t, n))));
        break;
      case 22:
        if (((s = n.memoizedState !== null || cn), !s)) {
          (e = (e !== null && e.memoizedState !== null) || Ht), (o = cn);
          var u = Ht;
          (cn = s),
            (Ht = e) && !u ? jn(t, n, (n.subtreeFlags & 8772) !== 0) : Cn(t, n),
            (cn = o),
            (Ht = u);
        }
        break;
      case 30:
        break;
      default:
        Cn(t, n);
    }
  }
  function tm(t) {
    var e = t.alternate;
    e !== null && ((t.alternate = null), tm(e)),
      (t.child = null),
      (t.deletions = null),
      (t.sibling = null),
      t.tag === 5 && ((e = t.stateNode), e !== null && qr(e)),
      (t.stateNode = null),
      (t.return = null),
      (t.dependencies = null),
      (t.memoizedProps = null),
      (t.memoizedState = null),
      (t.pendingProps = null),
      (t.stateNode = null),
      (t.updateQueue = null);
  }
  var Vt = null,
    de = !1;
  function fn(t, e, n) {
    for (n = n.child; n !== null; ) em(t, e, n), (n = n.sibling);
  }
  function em(t, e, n) {
    if (pe && typeof pe.onCommitFiberUnmount == "function")
      try {
        pe.onCommitFiberUnmount(ma, n);
      } catch {}
    switch (n.tag) {
      case 26:
        Ht || Ze(n, e),
          fn(t, e, n),
          n.memoizedState
            ? n.memoizedState.count--
            : n.stateNode && ((n = n.stateNode), n.parentNode.removeChild(n));
        break;
      case 27:
        Ht || Ze(n, e);
        var s = Vt,
          o = de;
        zn(n.type) && ((Vt = n.stateNode), (de = !1)),
          fn(t, e, n),
          ns(n.stateNode),
          (Vt = s),
          (de = o);
        break;
      case 5:
        Ht || Ze(n, e);
      case 6:
        if (
          ((s = Vt),
          (o = de),
          (Vt = null),
          fn(t, e, n),
          (Vt = s),
          (de = o),
          Vt !== null)
        )
          if (de)
            try {
              (Vt.nodeType === 9
                ? Vt.body
                : Vt.nodeName === "HTML"
                  ? Vt.ownerDocument.body
                  : Vt
              ).removeChild(n.stateNode);
            } catch (u) {
              Dt(n, e, u);
            }
          else
            try {
              Vt.removeChild(n.stateNode);
            } catch (u) {
              Dt(n, e, u);
            }
        break;
      case 18:
        Vt !== null &&
          (de
            ? ((t = Vt),
              Xm(
                t.nodeType === 9
                  ? t.body
                  : t.nodeName === "HTML"
                    ? t.ownerDocument.body
                    : t,
                n.stateNode,
              ),
              cs(t))
            : Xm(Vt, n.stateNode));
        break;
      case 4:
        (s = Vt),
          (o = de),
          (Vt = n.stateNode.containerInfo),
          (de = !0),
          fn(t, e, n),
          (Vt = s),
          (de = o);
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        Ht || On(2, n, e), Ht || On(4, n, e), fn(t, e, n);
        break;
      case 1:
        Ht ||
          (Ze(n, e),
          (s = n.stateNode),
          typeof s.componentWillUnmount == "function" && Qh(n, e, s)),
          fn(t, e, n);
        break;
      case 21:
        fn(t, e, n);
        break;
      case 22:
        (Ht = (s = Ht) || n.memoizedState !== null), fn(t, e, n), (Ht = s);
        break;
      default:
        fn(t, e, n);
    }
  }
  function nm(t, e) {
    if (
      e.memoizedState === null &&
      ((t = e.alternate),
      t !== null &&
        ((t = t.memoizedState), t !== null && ((t = t.dehydrated), t !== null)))
    )
      try {
        cs(t);
      } catch (n) {
        Dt(e, e.return, n);
      }
  }
  function d1(t) {
    switch (t.tag) {
      case 13:
      case 19:
        var e = t.stateNode;
        return e === null && (e = t.stateNode = new Wh()), e;
      case 22:
        return (
          (t = t.stateNode),
          (e = t._retryCache),
          e === null && (e = t._retryCache = new Wh()),
          e
        );
      default:
        throw Error(l(435, t.tag));
    }
  }
  function fu(t, e) {
    var n = d1(t);
    e.forEach(function (s) {
      var o = b1.bind(null, t, s);
      n.has(s) || (n.add(s), s.then(o, o));
    });
  }
  function Se(t, e) {
    var n = e.deletions;
    if (n !== null)
      for (var s = 0; s < n.length; s++) {
        var o = n[s],
          u = t,
          h = e,
          v = h;
        t: for (; v !== null; ) {
          switch (v.tag) {
            case 27:
              if (zn(v.type)) {
                (Vt = v.stateNode), (de = !1);
                break t;
              }
              break;
            case 5:
              (Vt = v.stateNode), (de = !1);
              break t;
            case 3:
            case 4:
              (Vt = v.stateNode.containerInfo), (de = !0);
              break t;
          }
          v = v.return;
        }
        if (Vt === null) throw Error(l(160));
        em(u, h, o),
          (Vt = null),
          (de = !1),
          (u = o.alternate),
          u !== null && (u.return = null),
          (o.return = null);
      }
    if (e.subtreeFlags & 13878)
      for (e = e.child; e !== null; ) im(e, t), (e = e.sibling);
  }
  var Ue = null;
  function im(t, e) {
    var n = t.alternate,
      s = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        Se(e, t),
          xe(t),
          s & 4 && (On(3, t, t.return), Ka(3, t), On(5, t, t.return));
        break;
      case 1:
        Se(e, t),
          xe(t),
          s & 512 && (Ht || n === null || Ze(n, n.return)),
          s & 64 &&
            cn &&
            ((t = t.updateQueue),
            t !== null &&
              ((s = t.callbacks),
              s !== null &&
                ((n = t.shared.hiddenCallbacks),
                (t.shared.hiddenCallbacks = n === null ? s : n.concat(s)))));
        break;
      case 26:
        var o = Ue;
        if (
          (Se(e, t),
          xe(t),
          s & 512 && (Ht || n === null || Ze(n, n.return)),
          s & 4)
        ) {
          var u = n !== null ? n.memoizedState : null;
          if (((s = t.memoizedState), n === null))
            if (s === null)
              if (t.stateNode === null) {
                t: {
                  (s = t.type),
                    (n = t.memoizedProps),
                    (o = o.ownerDocument || o);
                  e: switch (s) {
                    case "title":
                      (u = o.getElementsByTagName("title")[0]),
                        (!u ||
                          u[ga] ||
                          u[ie] ||
                          u.namespaceURI === "http://www.w3.org/2000/svg" ||
                          u.hasAttribute("itemprop")) &&
                          ((u = o.createElement(s)),
                          o.head.insertBefore(
                            u,
                            o.querySelector("head > title"),
                          )),
                        te(u, s, n),
                        (u[ie] = t),
                        Pt(u),
                        (s = u);
                      break t;
                    case "link":
                      var h = $m("link", "href", o).get(s + (n.href || ""));
                      if (h) {
                        for (var v = 0; v < h.length; v++)
                          if (
                            ((u = h[v]),
                            u.getAttribute("href") ===
                              (n.href == null || n.href === ""
                                ? null
                                : n.href) &&
                              u.getAttribute("rel") ===
                                (n.rel == null ? null : n.rel) &&
                              u.getAttribute("title") ===
                                (n.title == null ? null : n.title) &&
                              u.getAttribute("crossorigin") ===
                                (n.crossOrigin == null ? null : n.crossOrigin))
                          ) {
                            h.splice(v, 1);
                            break e;
                          }
                      }
                      (u = o.createElement(s)),
                        te(u, s, n),
                        o.head.appendChild(u);
                      break;
                    case "meta":
                      if (
                        (h = $m("meta", "content", o).get(
                          s + (n.content || ""),
                        ))
                      ) {
                        for (v = 0; v < h.length; v++)
                          if (
                            ((u = h[v]),
                            u.getAttribute("content") ===
                              (n.content == null ? null : "" + n.content) &&
                              u.getAttribute("name") ===
                                (n.name == null ? null : n.name) &&
                              u.getAttribute("property") ===
                                (n.property == null ? null : n.property) &&
                              u.getAttribute("http-equiv") ===
                                (n.httpEquiv == null ? null : n.httpEquiv) &&
                              u.getAttribute("charset") ===
                                (n.charSet == null ? null : n.charSet))
                          ) {
                            h.splice(v, 1);
                            break e;
                          }
                      }
                      (u = o.createElement(s)),
                        te(u, s, n),
                        o.head.appendChild(u);
                      break;
                    default:
                      throw Error(l(468, s));
                  }
                  (u[ie] = t), Pt(u), (s = u);
                }
                t.stateNode = s;
              } else Wm(o, t.type, t.stateNode);
            else t.stateNode = Fm(o, s, t.memoizedProps);
          else
            u !== s
              ? (u === null
                  ? n.stateNode !== null &&
                    ((n = n.stateNode), n.parentNode.removeChild(n))
                  : u.count--,
                s === null
                  ? Wm(o, t.type, t.stateNode)
                  : Fm(o, s, t.memoizedProps))
              : s === null &&
                t.stateNode !== null &&
                ru(t, t.memoizedProps, n.memoizedProps);
        }
        break;
      case 27:
        Se(e, t),
          xe(t),
          s & 512 && (Ht || n === null || Ze(n, n.return)),
          n !== null && s & 4 && ru(t, t.memoizedProps, n.memoizedProps);
        break;
      case 5:
        if (
          (Se(e, t),
          xe(t),
          s & 512 && (Ht || n === null || Ze(n, n.return)),
          t.flags & 32)
        ) {
          o = t.stateNode;
          try {
            Mi(o, "");
          } catch (w) {
            Dt(t, t.return, w);
          }
        }
        s & 4 &&
          t.stateNode != null &&
          ((o = t.memoizedProps), ru(t, o, n !== null ? n.memoizedProps : o)),
          s & 1024 && (cu = !0);
        break;
      case 6:
        if ((Se(e, t), xe(t), s & 4)) {
          if (t.stateNode === null) throw Error(l(162));
          (s = t.memoizedProps), (n = t.stateNode);
          try {
            n.nodeValue = s;
          } catch (w) {
            Dt(t, t.return, w);
          }
        }
        break;
      case 3:
        if (
          ((Yl = null),
          (o = Ue),
          (Ue = Hl(e.containerInfo)),
          Se(e, t),
          (Ue = o),
          xe(t),
          s & 4 && n !== null && n.memoizedState.isDehydrated)
        )
          try {
            cs(e.containerInfo);
          } catch (w) {
            Dt(t, t.return, w);
          }
        cu && ((cu = !1), am(t));
        break;
      case 4:
        (s = Ue),
          (Ue = Hl(t.stateNode.containerInfo)),
          Se(e, t),
          xe(t),
          (Ue = s);
        break;
      case 12:
        Se(e, t), xe(t);
        break;
      case 13:
        Se(e, t),
          xe(t),
          t.child.flags & 8192 &&
            (t.memoizedState !== null) !=
              (n !== null && n.memoizedState !== null) &&
            (gu = qe()),
          s & 4 &&
            ((s = t.updateQueue),
            s !== null && ((t.updateQueue = null), fu(t, s)));
        break;
      case 22:
        o = t.memoizedState !== null;
        var T = n !== null && n.memoizedState !== null,
          C = cn,
          B = Ht;
        if (
          ((cn = C || o),
          (Ht = B || T),
          Se(e, t),
          (Ht = B),
          (cn = C),
          xe(t),
          s & 8192)
        )
          t: for (
            e = t.stateNode,
              e._visibility = o ? e._visibility & -2 : e._visibility | 1,
              o && (n === null || T || cn || Ht || li(t)),
              n = null,
              e = t;
            ;
          ) {
            if (e.tag === 5 || e.tag === 26) {
              if (n === null) {
                T = n = e;
                try {
                  if (((u = T.stateNode), o))
                    (h = u.style),
                      typeof h.setProperty == "function"
                        ? h.setProperty("display", "none", "important")
                        : (h.display = "none");
                  else {
                    v = T.stateNode;
                    var Y = T.memoizedProps.style,
                      N =
                        Y != null && Y.hasOwnProperty("display")
                          ? Y.display
                          : null;
                    v.style.display =
                      N == null || typeof N == "boolean" ? "" : ("" + N).trim();
                  }
                } catch (w) {
                  Dt(T, T.return, w);
                }
              }
            } else if (e.tag === 6) {
              if (n === null) {
                T = e;
                try {
                  T.stateNode.nodeValue = o ? "" : T.memoizedProps;
                } catch (w) {
                  Dt(T, T.return, w);
                }
              }
            } else if (
              ((e.tag !== 22 && e.tag !== 23) ||
                e.memoizedState === null ||
                e === t) &&
              e.child !== null
            ) {
              (e.child.return = e), (e = e.child);
              continue;
            }
            if (e === t) break t;
            for (; e.sibling === null; ) {
              if (e.return === null || e.return === t) break t;
              n === e && (n = null), (e = e.return);
            }
            n === e && (n = null),
              (e.sibling.return = e.return),
              (e = e.sibling);
          }
        s & 4 &&
          ((s = t.updateQueue),
          s !== null &&
            ((n = s.retryQueue),
            n !== null && ((s.retryQueue = null), fu(t, n))));
        break;
      case 19:
        Se(e, t),
          xe(t),
          s & 4 &&
            ((s = t.updateQueue),
            s !== null && ((t.updateQueue = null), fu(t, s)));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        Se(e, t), xe(t);
    }
  }
  function xe(t) {
    var e = t.flags;
    if (e & 2) {
      try {
        for (var n, s = t.return; s !== null; ) {
          if (Fh(s)) {
            n = s;
            break;
          }
          s = s.return;
        }
        if (n == null) throw Error(l(160));
        switch (n.tag) {
          case 27:
            var o = n.stateNode,
              u = ou(t);
            Rl(t, u, o);
            break;
          case 5:
            var h = n.stateNode;
            n.flags & 32 && (Mi(h, ""), (n.flags &= -33));
            var v = ou(t);
            Rl(t, v, h);
            break;
          case 3:
          case 4:
            var T = n.stateNode.containerInfo,
              C = ou(t);
            uu(t, C, T);
            break;
          default:
            throw Error(l(161));
        }
      } catch (B) {
        Dt(t, t.return, B);
      }
      t.flags &= -3;
    }
    e & 4096 && (t.flags &= -4097);
  }
  function am(t) {
    if (t.subtreeFlags & 1024)
      for (t = t.child; t !== null; ) {
        var e = t;
        am(e),
          e.tag === 5 && e.flags & 1024 && e.stateNode.reset(),
          (t = t.sibling);
      }
  }
  function Cn(t, e) {
    if (e.subtreeFlags & 8772)
      for (e = e.child; e !== null; ) Ih(t, e.alternate, e), (e = e.sibling);
  }
  function li(t) {
    for (t = t.child; t !== null; ) {
      var e = t;
      switch (e.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          On(4, e, e.return), li(e);
          break;
        case 1:
          Ze(e, e.return);
          var n = e.stateNode;
          typeof n.componentWillUnmount == "function" && Qh(e, e.return, n),
            li(e);
          break;
        case 27:
          ns(e.stateNode);
        case 26:
        case 5:
          Ze(e, e.return), li(e);
          break;
        case 22:
          e.memoizedState === null && li(e);
          break;
        case 30:
          li(e);
          break;
        default:
          li(e);
      }
      t = t.sibling;
    }
  }
  function jn(t, e, n) {
    for (n = n && (e.subtreeFlags & 8772) !== 0, e = e.child; e !== null; ) {
      var s = e.alternate,
        o = t,
        u = e,
        h = u.flags;
      switch (u.tag) {
        case 0:
        case 11:
        case 15:
          jn(o, u, n), Ka(4, u);
          break;
        case 1:
          if (
            (jn(o, u, n),
            (s = u),
            (o = s.stateNode),
            typeof o.componentDidMount == "function")
          )
            try {
              o.componentDidMount();
            } catch (C) {
              Dt(s, s.return, C);
            }
          if (((s = u), (o = s.updateQueue), o !== null)) {
            var v = s.stateNode;
            try {
              var T = o.shared.hiddenCallbacks;
              if (T !== null)
                for (o.shared.hiddenCallbacks = null, o = 0; o < T.length; o++)
                  Vd(T[o], v);
            } catch (C) {
              Dt(s, s.return, C);
            }
          }
          n && h & 64 && Ph(u), Pa(u, u.return);
          break;
        case 27:
          $h(u);
        case 26:
        case 5:
          jn(o, u, n), n && s === null && h & 4 && Jh(u), Pa(u, u.return);
          break;
        case 12:
          jn(o, u, n);
          break;
        case 13:
          jn(o, u, n), n && h & 4 && nm(o, u);
          break;
        case 22:
          u.memoizedState === null && jn(o, u, n), Pa(u, u.return);
          break;
        case 30:
          break;
        default:
          jn(o, u, n);
      }
      e = e.sibling;
    }
  }
  function du(t, e) {
    var n = null;
    t !== null &&
      t.memoizedState !== null &&
      t.memoizedState.cachePool !== null &&
      (n = t.memoizedState.cachePool.pool),
      (t = null),
      e.memoizedState !== null &&
        e.memoizedState.cachePool !== null &&
        (t = e.memoizedState.cachePool.pool),
      t !== n && (t != null && t.refCount++, n != null && wa(n));
  }
  function hu(t, e) {
    (t = null),
      e.alternate !== null && (t = e.alternate.memoizedState.cache),
      (e = e.memoizedState.cache),
      e !== t && (e.refCount++, t != null && wa(t));
  }
  function Ke(t, e, n, s) {
    if (e.subtreeFlags & 10256)
      for (e = e.child; e !== null; ) sm(t, e, n, s), (e = e.sibling);
  }
  function sm(t, e, n, s) {
    var o = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        Ke(t, e, n, s), o & 2048 && Ka(9, e);
        break;
      case 1:
        Ke(t, e, n, s);
        break;
      case 3:
        Ke(t, e, n, s),
          o & 2048 &&
            ((t = null),
            e.alternate !== null && (t = e.alternate.memoizedState.cache),
            (e = e.memoizedState.cache),
            e !== t && (e.refCount++, t != null && wa(t)));
        break;
      case 12:
        if (o & 2048) {
          Ke(t, e, n, s), (t = e.stateNode);
          try {
            var u = e.memoizedProps,
              h = u.id,
              v = u.onPostCommit;
            typeof v == "function" &&
              v(
                h,
                e.alternate === null ? "mount" : "update",
                t.passiveEffectDuration,
                -0,
              );
          } catch (T) {
            Dt(e, e.return, T);
          }
        } else Ke(t, e, n, s);
        break;
      case 13:
        Ke(t, e, n, s);
        break;
      case 23:
        break;
      case 22:
        (u = e.stateNode),
          (h = e.alternate),
          e.memoizedState !== null
            ? u._visibility & 2
              ? Ke(t, e, n, s)
              : Qa(t, e)
            : u._visibility & 2
              ? Ke(t, e, n, s)
              : ((u._visibility |= 2),
                ki(t, e, n, s, (e.subtreeFlags & 10256) !== 0)),
          o & 2048 && du(h, e);
        break;
      case 24:
        Ke(t, e, n, s), o & 2048 && hu(e.alternate, e);
        break;
      default:
        Ke(t, e, n, s);
    }
  }
  function ki(t, e, n, s, o) {
    for (o = o && (e.subtreeFlags & 10256) !== 0, e = e.child; e !== null; ) {
      var u = t,
        h = e,
        v = n,
        T = s,
        C = h.flags;
      switch (h.tag) {
        case 0:
        case 11:
        case 15:
          ki(u, h, v, T, o), Ka(8, h);
          break;
        case 23:
          break;
        case 22:
          var B = h.stateNode;
          h.memoizedState !== null
            ? B._visibility & 2
              ? ki(u, h, v, T, o)
              : Qa(u, h)
            : ((B._visibility |= 2), ki(u, h, v, T, o)),
            o && C & 2048 && du(h.alternate, h);
          break;
        case 24:
          ki(u, h, v, T, o), o && C & 2048 && hu(h.alternate, h);
          break;
        default:
          ki(u, h, v, T, o);
      }
      e = e.sibling;
    }
  }
  function Qa(t, e) {
    if (e.subtreeFlags & 10256)
      for (e = e.child; e !== null; ) {
        var n = t,
          s = e,
          o = s.flags;
        switch (s.tag) {
          case 22:
            Qa(n, s), o & 2048 && du(s.alternate, s);
            break;
          case 24:
            Qa(n, s), o & 2048 && hu(s.alternate, s);
            break;
          default:
            Qa(n, s);
        }
        e = e.sibling;
      }
  }
  var Ja = 8192;
  function Zi(t) {
    if (t.subtreeFlags & Ja)
      for (t = t.child; t !== null; ) lm(t), (t = t.sibling);
  }
  function lm(t) {
    switch (t.tag) {
      case 26:
        Zi(t),
          t.flags & Ja &&
            t.memoizedState !== null &&
            $1(Ue, t.memoizedState, t.memoizedProps);
        break;
      case 5:
        Zi(t);
        break;
      case 3:
      case 4:
        var e = Ue;
        (Ue = Hl(t.stateNode.containerInfo)), Zi(t), (Ue = e);
        break;
      case 22:
        t.memoizedState === null &&
          ((e = t.alternate),
          e !== null && e.memoizedState !== null
            ? ((e = Ja), (Ja = 16777216), Zi(t), (Ja = e))
            : Zi(t));
        break;
      default:
        Zi(t);
    }
  }
  function rm(t) {
    var e = t.alternate;
    if (e !== null && ((t = e.child), t !== null)) {
      e.child = null;
      do (e = t.sibling), (t.sibling = null), (t = e);
      while (t !== null);
    }
  }
  function Fa(t) {
    var e = t.deletions;
    if ((t.flags & 16) !== 0) {
      if (e !== null)
        for (var n = 0; n < e.length; n++) {
          var s = e[n];
          (Jt = s), um(s, t);
        }
      rm(t);
    }
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; ) om(t), (t = t.sibling);
  }
  function om(t) {
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        Fa(t), t.flags & 2048 && On(9, t, t.return);
        break;
      case 3:
        Fa(t);
        break;
      case 12:
        Fa(t);
        break;
      case 22:
        var e = t.stateNode;
        t.memoizedState !== null &&
        e._visibility & 2 &&
        (t.return === null || t.return.tag !== 13)
          ? ((e._visibility &= -3), Dl(t))
          : Fa(t);
        break;
      default:
        Fa(t);
    }
  }
  function Dl(t) {
    var e = t.deletions;
    if ((t.flags & 16) !== 0) {
      if (e !== null)
        for (var n = 0; n < e.length; n++) {
          var s = e[n];
          (Jt = s), um(s, t);
        }
      rm(t);
    }
    for (t = t.child; t !== null; ) {
      switch (((e = t), e.tag)) {
        case 0:
        case 11:
        case 15:
          On(8, e, e.return), Dl(e);
          break;
        case 22:
          (n = e.stateNode),
            n._visibility & 2 && ((n._visibility &= -3), Dl(e));
          break;
        default:
          Dl(e);
      }
      t = t.sibling;
    }
  }
  function um(t, e) {
    for (; Jt !== null; ) {
      var n = Jt;
      switch (n.tag) {
        case 0:
        case 11:
        case 15:
          On(8, n, e);
          break;
        case 23:
        case 22:
          if (n.memoizedState !== null && n.memoizedState.cachePool !== null) {
            var s = n.memoizedState.cachePool.pool;
            s != null && s.refCount++;
          }
          break;
        case 24:
          wa(n.memoizedState.cache);
      }
      if (((s = n.child), s !== null)) (s.return = n), (Jt = s);
      else
        t: for (n = t; Jt !== null; ) {
          s = Jt;
          var o = s.sibling,
            u = s.return;
          if ((tm(s), s === n)) {
            Jt = null;
            break t;
          }
          if (o !== null) {
            (o.return = u), (Jt = o);
            break t;
          }
          Jt = u;
        }
    }
  }
  var h1 = {
      getCacheForType: function (t) {
        var e = ae(Xt),
          n = e.data.get(t);
        return n === void 0 && ((n = t()), e.data.set(t, n)), n;
      },
    },
    m1 = typeof WeakMap == "function" ? WeakMap : Map,
    bt = 0,
    jt = null,
    dt = null,
    yt = 0,
    Tt = 0,
    be = null,
    Nn = !1,
    Ki = !1,
    mu = !1,
    dn = 0,
    zt = 0,
    wn = 0,
    ri = 0,
    pu = 0,
    we = 0,
    Pi = 0,
    $a = null,
    he = null,
    yu = !1,
    gu = 0,
    Ol = 1 / 0,
    Cl = null,
    Vn = null,
    It = 0,
    _n = null,
    Qi = null,
    Ji = 0,
    vu = 0,
    Su = null,
    cm = null,
    Wa = 0,
    xu = null;
  function Te() {
    if ((bt & 2) !== 0 && yt !== 0) return yt & -yt;
    if (z.T !== null) {
      var t = zi;
      return t !== 0 ? t : Du();
    }
    return Rf();
  }
  function fm() {
    we === 0 && (we = (yt & 536870912) === 0 || xt ? Tf() : 536870912);
    var t = Ne.current;
    return t !== null && (t.flags |= 32), we;
  }
  function Ee(t, e, n) {
    ((t === jt && (Tt === 2 || Tt === 9)) || t.cancelPendingCommit !== null) &&
      (Fi(t, 0), Ln(t, yt, we, !1)),
      ya(t, n),
      ((bt & 2) === 0 || t !== jt) &&
        (t === jt &&
          ((bt & 2) === 0 && (ri |= n), zt === 4 && Ln(t, yt, we, !1)),
        Pe(t));
  }
  function dm(t, e, n) {
    if ((bt & 6) !== 0) throw Error(l(327));
    var s = (!n && (e & 124) === 0 && (e & t.expiredLanes) === 0) || pa(t, e),
      o = s ? g1(t, e) : Eu(t, e, !0),
      u = s;
    do {
      if (o === 0) {
        Ki && !s && Ln(t, e, 0, !1);
        break;
      } else {
        if (((n = t.current.alternate), u && !p1(n))) {
          (o = Eu(t, e, !1)), (u = !1);
          continue;
        }
        if (o === 2) {
          if (((u = e), t.errorRecoveryDisabledLanes & u)) var h = 0;
          else
            (h = t.pendingLanes & -536870913),
              (h = h !== 0 ? h : h & 536870912 ? 536870912 : 0);
          if (h !== 0) {
            e = h;
            t: {
              var v = t;
              o = $a;
              var T = v.current.memoizedState.isDehydrated;
              if ((T && (Fi(v, h).flags |= 256), (h = Eu(v, h, !1)), h !== 2)) {
                if (mu && !T) {
                  (v.errorRecoveryDisabledLanes |= u), (ri |= u), (o = 4);
                  break t;
                }
                (u = he),
                  (he = o),
                  u !== null && (he === null ? (he = u) : he.push.apply(he, u));
              }
              o = h;
            }
            if (((u = !1), o !== 2)) continue;
          }
        }
        if (o === 1) {
          Fi(t, 0), Ln(t, e, 0, !0);
          break;
        }
        t: {
          switch (((s = t), (u = o), u)) {
            case 0:
            case 1:
              throw Error(l(345));
            case 4:
              if ((e & 4194048) !== e) break;
            case 6:
              Ln(s, e, we, !Nn);
              break t;
            case 2:
              he = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(l(329));
          }
          if ((e & 62914560) === e && ((o = gu + 300 - qe()), 10 < o)) {
            if ((Ln(s, e, we, !Nn), Gs(s, 0, !0) !== 0)) break t;
            s.timeoutHandle = Ym(
              hm.bind(null, s, n, he, Cl, yu, e, we, ri, Pi, Nn, u, 2, -0, 0),
              o,
            );
            break t;
          }
          hm(s, n, he, Cl, yu, e, we, ri, Pi, Nn, u, 0, -0, 0);
        }
      }
      break;
    } while (!0);
    Pe(t);
  }
  function hm(t, e, n, s, o, u, h, v, T, C, B, Y, N, w) {
    if (
      ((t.timeoutHandle = -1),
      (Y = e.subtreeFlags),
      (Y & 8192 || (Y & 16785408) === 16785408) &&
        ((ss = { stylesheets: null, count: 0, unsuspend: F1 }),
        lm(e),
        (Y = W1()),
        Y !== null))
    ) {
      (t.cancelPendingCommit = Y(
        xm.bind(null, t, e, u, n, s, o, h, v, T, B, 1, N, w),
      )),
        Ln(t, u, h, !C);
      return;
    }
    xm(t, e, u, n, s, o, h, v, T);
  }
  function p1(t) {
    for (var e = t; ; ) {
      var n = e.tag;
      if (
        (n === 0 || n === 11 || n === 15) &&
        e.flags & 16384 &&
        ((n = e.updateQueue), n !== null && ((n = n.stores), n !== null))
      )
        for (var s = 0; s < n.length; s++) {
          var o = n[s],
            u = o.getSnapshot;
          o = o.value;
          try {
            if (!ge(u(), o)) return !1;
          } catch {
            return !1;
          }
        }
      if (((n = e.child), e.subtreeFlags & 16384 && n !== null))
        (n.return = e), (e = n);
      else {
        if (e === t) break;
        for (; e.sibling === null; ) {
          if (e.return === null || e.return === t) return !0;
          e = e.return;
        }
        (e.sibling.return = e.return), (e = e.sibling);
      }
    }
    return !0;
  }
  function Ln(t, e, n, s) {
    (e &= ~pu),
      (e &= ~ri),
      (t.suspendedLanes |= e),
      (t.pingedLanes &= ~e),
      s && (t.warmLanes |= e),
      (s = t.expirationTimes);
    for (var o = e; 0 < o; ) {
      var u = 31 - ye(o),
        h = 1 << u;
      (s[u] = -1), (o &= ~h);
    }
    n !== 0 && Af(t, n, e);
  }
  function jl() {
    return (bt & 6) === 0 ? (Ia(0), !1) : !0;
  }
  function bu() {
    if (dt !== null) {
      if (Tt === 0) var t = dt.return;
      else (t = dt), (an = ei = null), Bo(t), (qi = null), (Xa = 0), (t = dt);
      for (; t !== null; ) Kh(t.alternate, t), (t = t.return);
      dt = null;
    }
  }
  function Fi(t, e) {
    var n = t.timeoutHandle;
    n !== -1 && ((t.timeoutHandle = -1), V1(n)),
      (n = t.cancelPendingCommit),
      n !== null && ((t.cancelPendingCommit = null), n()),
      bu(),
      (jt = t),
      (dt = n = tn(t.current, null)),
      (yt = e),
      (Tt = 0),
      (be = null),
      (Nn = !1),
      (Ki = pa(t, e)),
      (mu = !1),
      (Pi = we = pu = ri = wn = zt = 0),
      (he = $a = null),
      (yu = !1),
      (e & 8) !== 0 && (e |= e & 32);
    var s = t.entangledLanes;
    if (s !== 0)
      for (t = t.entanglements, s &= e; 0 < s; ) {
        var o = 31 - ye(s),
          u = 1 << o;
        (e |= t[o]), (s &= ~u);
      }
    return (dn = e), Ws(), n;
  }
  function mm(t, e) {
    (ct = null),
      (z.H = gl),
      e === _a || e === rl
        ? ((e = Nd()), (Tt = 3))
        : e === Od
          ? ((e = Nd()), (Tt = 4))
          : (Tt =
              e === wh
                ? 8
                : e !== null &&
                    typeof e == "object" &&
                    typeof e.then == "function"
                  ? 6
                  : 1),
      (be = e),
      dt === null && ((zt = 1), Tl(t, De(e, t.current)));
  }
  function pm() {
    var t = z.H;
    return (z.H = gl), t === null ? gl : t;
  }
  function ym() {
    var t = z.A;
    return (z.A = h1), t;
  }
  function Tu() {
    (zt = 4),
      Nn || ((yt & 4194048) !== yt && Ne.current !== null) || (Ki = !0),
      ((wn & 134217727) === 0 && (ri & 134217727) === 0) ||
        jt === null ||
        Ln(jt, yt, we, !1);
  }
  function Eu(t, e, n) {
    var s = bt;
    bt |= 2;
    var o = pm(),
      u = ym();
    (jt !== t || yt !== e) && ((Cl = null), Fi(t, e)), (e = !1);
    var h = zt;
    t: do
      try {
        if (Tt !== 0 && dt !== null) {
          var v = dt,
            T = be;
          switch (Tt) {
            case 8:
              bu(), (h = 6);
              break t;
            case 3:
            case 2:
            case 9:
            case 6:
              Ne.current === null && (e = !0);
              var C = Tt;
              if (((Tt = 0), (be = null), $i(t, v, T, C), n && Ki)) {
                h = 0;
                break t;
              }
              break;
            default:
              (C = Tt), (Tt = 0), (be = null), $i(t, v, T, C);
          }
        }
        y1(), (h = zt);
        break;
      } catch (B) {
        mm(t, B);
      }
    while (!0);
    return (
      e && t.shellSuspendCounter++,
      (an = ei = null),
      (bt = s),
      (z.H = o),
      (z.A = u),
      dt === null && ((jt = null), (yt = 0), Ws()),
      h
    );
  }
  function y1() {
    for (; dt !== null; ) gm(dt);
  }
  function g1(t, e) {
    var n = bt;
    bt |= 2;
    var s = pm(),
      o = ym();
    jt !== t || yt !== e
      ? ((Cl = null), (Ol = qe() + 500), Fi(t, e))
      : (Ki = pa(t, e));
    t: do
      try {
        if (Tt !== 0 && dt !== null) {
          e = dt;
          var u = be;
          e: switch (Tt) {
            case 1:
              (Tt = 0), (be = null), $i(t, e, u, 1);
              break;
            case 2:
            case 9:
              if (Cd(u)) {
                (Tt = 0), (be = null), vm(e);
                break;
              }
              (e = function () {
                (Tt !== 2 && Tt !== 9) || jt !== t || (Tt = 7), Pe(t);
              }),
                u.then(e, e);
              break t;
            case 3:
              Tt = 7;
              break t;
            case 4:
              Tt = 5;
              break t;
            case 7:
              Cd(u)
                ? ((Tt = 0), (be = null), vm(e))
                : ((Tt = 0), (be = null), $i(t, e, u, 7));
              break;
            case 5:
              var h = null;
              switch (dt.tag) {
                case 26:
                  h = dt.memoizedState;
                case 5:
                case 27:
                  var v = dt;
                  if (!h || Im(h)) {
                    (Tt = 0), (be = null);
                    var T = v.sibling;
                    if (T !== null) dt = T;
                    else {
                      var C = v.return;
                      C !== null ? ((dt = C), Nl(C)) : (dt = null);
                    }
                    break e;
                  }
              }
              (Tt = 0), (be = null), $i(t, e, u, 5);
              break;
            case 6:
              (Tt = 0), (be = null), $i(t, e, u, 6);
              break;
            case 8:
              bu(), (zt = 6);
              break t;
            default:
              throw Error(l(462));
          }
        }
        v1();
        break;
      } catch (B) {
        mm(t, B);
      }
    while (!0);
    return (
      (an = ei = null),
      (z.H = s),
      (z.A = o),
      (bt = n),
      dt !== null ? 0 : ((jt = null), (yt = 0), Ws(), zt)
    );
  }
  function v1() {
    for (; dt !== null && !G0(); ) gm(dt);
  }
  function gm(t) {
    var e = kh(t.alternate, t, dn);
    (t.memoizedProps = t.pendingProps), e === null ? Nl(t) : (dt = e);
  }
  function vm(t) {
    var e = t,
      n = e.alternate;
    switch (e.tag) {
      case 15:
      case 0:
        e = Bh(n, e, e.pendingProps, e.type, void 0, yt);
        break;
      case 11:
        e = Bh(n, e, e.pendingProps, e.type.render, e.ref, yt);
        break;
      case 5:
        Bo(e);
      default:
        Kh(n, e), (e = dt = Sd(e, dn)), (e = kh(n, e, dn));
    }
    (t.memoizedProps = t.pendingProps), e === null ? Nl(t) : (dt = e);
  }
  function $i(t, e, n, s) {
    (an = ei = null), Bo(e), (qi = null), (Xa = 0);
    var o = e.return;
    try {
      if (r1(t, o, e, n, yt)) {
        (zt = 1), Tl(t, De(n, t.current)), (dt = null);
        return;
      }
    } catch (u) {
      if (o !== null) throw ((dt = o), u);
      (zt = 1), Tl(t, De(n, t.current)), (dt = null);
      return;
    }
    e.flags & 32768
      ? (xt || s === 1
          ? (t = !0)
          : Ki || (yt & 536870912) !== 0
            ? (t = !1)
            : ((Nn = t = !0),
              (s === 2 || s === 9 || s === 3 || s === 6) &&
                ((s = Ne.current),
                s !== null && s.tag === 13 && (s.flags |= 16384))),
        Sm(e, t))
      : Nl(e);
  }
  function Nl(t) {
    var e = t;
    do {
      if ((e.flags & 32768) !== 0) {
        Sm(e, Nn);
        return;
      }
      t = e.return;
      var n = u1(e.alternate, e, dn);
      if (n !== null) {
        dt = n;
        return;
      }
      if (((e = e.sibling), e !== null)) {
        dt = e;
        return;
      }
      dt = e = t;
    } while (e !== null);
    zt === 0 && (zt = 5);
  }
  function Sm(t, e) {
    do {
      var n = c1(t.alternate, t);
      if (n !== null) {
        (n.flags &= 32767), (dt = n);
        return;
      }
      if (
        ((n = t.return),
        n !== null &&
          ((n.flags |= 32768), (n.subtreeFlags = 0), (n.deletions = null)),
        !e && ((t = t.sibling), t !== null))
      ) {
        dt = t;
        return;
      }
      dt = t = n;
    } while (t !== null);
    (zt = 6), (dt = null);
  }
  function xm(t, e, n, s, o, u, h, v, T) {
    t.cancelPendingCommit = null;
    do wl();
    while (It !== 0);
    if ((bt & 6) !== 0) throw Error(l(327));
    if (e !== null) {
      if (e === t.current) throw Error(l(177));
      if (
        ((u = e.lanes | e.childLanes),
        (u |= ho),
        F0(t, n, u, h, v, T),
        t === jt && ((dt = jt = null), (yt = 0)),
        (Qi = e),
        (_n = t),
        (Ji = n),
        (vu = u),
        (Su = o),
        (cm = s),
        (e.subtreeFlags & 10256) !== 0 || (e.flags & 10256) !== 0
          ? ((t.callbackNode = null),
            (t.callbackPriority = 0),
            T1(Us, function () {
              return Mm(), null;
            }))
          : ((t.callbackNode = null), (t.callbackPriority = 0)),
        (s = (e.flags & 13878) !== 0),
        (e.subtreeFlags & 13878) !== 0 || s)
      ) {
        (s = z.T), (z.T = null), (o = Z.p), (Z.p = 2), (h = bt), (bt |= 4);
        try {
          f1(t, e, n);
        } finally {
          (bt = h), (Z.p = o), (z.T = s);
        }
      }
      (It = 1), bm(), Tm(), Em();
    }
  }
  function bm() {
    if (It === 1) {
      It = 0;
      var t = _n,
        e = Qi,
        n = (e.flags & 13878) !== 0;
      if ((e.subtreeFlags & 13878) !== 0 || n) {
        (n = z.T), (z.T = null);
        var s = Z.p;
        Z.p = 2;
        var o = bt;
        bt |= 4;
        try {
          im(e, t);
          var u = Lu,
            h = ud(t.containerInfo),
            v = u.focusedElem,
            T = u.selectionRange;
          if (
            h !== v &&
            v &&
            v.ownerDocument &&
            od(v.ownerDocument.documentElement, v)
          ) {
            if (T !== null && ro(v)) {
              var C = T.start,
                B = T.end;
              if ((B === void 0 && (B = C), "selectionStart" in v))
                (v.selectionStart = C),
                  (v.selectionEnd = Math.min(B, v.value.length));
              else {
                var Y = v.ownerDocument || document,
                  N = (Y && Y.defaultView) || window;
                if (N.getSelection) {
                  var w = N.getSelection(),
                    st = v.textContent.length,
                    it = Math.min(T.start, st),
                    Rt = T.end === void 0 ? it : Math.min(T.end, st);
                  !w.extend && it > Rt && ((h = Rt), (Rt = it), (it = h));
                  var D = rd(v, it),
                    M = rd(v, Rt);
                  if (
                    D &&
                    M &&
                    (w.rangeCount !== 1 ||
                      w.anchorNode !== D.node ||
                      w.anchorOffset !== D.offset ||
                      w.focusNode !== M.node ||
                      w.focusOffset !== M.offset)
                  ) {
                    var O = Y.createRange();
                    O.setStart(D.node, D.offset),
                      w.removeAllRanges(),
                      it > Rt
                        ? (w.addRange(O), w.extend(M.node, M.offset))
                        : (O.setEnd(M.node, M.offset), w.addRange(O));
                  }
                }
              }
            }
            for (Y = [], w = v; (w = w.parentNode); )
              w.nodeType === 1 &&
                Y.push({ element: w, left: w.scrollLeft, top: w.scrollTop });
            for (
              typeof v.focus == "function" && v.focus(), v = 0;
              v < Y.length;
              v++
            ) {
              var G = Y[v];
              (G.element.scrollLeft = G.left), (G.element.scrollTop = G.top);
            }
          }
          (kl = !!_u), (Lu = _u = null);
        } finally {
          (bt = o), (Z.p = s), (z.T = n);
        }
      }
      (t.current = e), (It = 2);
    }
  }
  function Tm() {
    if (It === 2) {
      It = 0;
      var t = _n,
        e = Qi,
        n = (e.flags & 8772) !== 0;
      if ((e.subtreeFlags & 8772) !== 0 || n) {
        (n = z.T), (z.T = null);
        var s = Z.p;
        Z.p = 2;
        var o = bt;
        bt |= 4;
        try {
          Ih(t, e.alternate, e);
        } finally {
          (bt = o), (Z.p = s), (z.T = n);
        }
      }
      It = 3;
    }
  }
  function Em() {
    if (It === 4 || It === 3) {
      (It = 0), Y0();
      var t = _n,
        e = Qi,
        n = Ji,
        s = cm;
      (e.subtreeFlags & 10256) !== 0 || (e.flags & 10256) !== 0
        ? (It = 5)
        : ((It = 0), (Qi = _n = null), Am(t, t.pendingLanes));
      var o = t.pendingLanes;
      if (
        (o === 0 && (Vn = null),
        Gr(n),
        (e = e.stateNode),
        pe && typeof pe.onCommitFiberRoot == "function")
      )
        try {
          pe.onCommitFiberRoot(ma, e, void 0, (e.current.flags & 128) === 128);
        } catch {}
      if (s !== null) {
        (e = z.T), (o = Z.p), (Z.p = 2), (z.T = null);
        try {
          for (var u = t.onRecoverableError, h = 0; h < s.length; h++) {
            var v = s[h];
            u(v.value, { componentStack: v.stack });
          }
        } finally {
          (z.T = e), (Z.p = o);
        }
      }
      (Ji & 3) !== 0 && wl(),
        Pe(t),
        (o = t.pendingLanes),
        (n & 4194090) !== 0 && (o & 42) !== 0
          ? t === xu
            ? Wa++
            : ((Wa = 0), (xu = t))
          : (Wa = 0),
        Ia(0);
    }
  }
  function Am(t, e) {
    (t.pooledCacheLanes &= e) === 0 &&
      ((e = t.pooledCache), e != null && ((t.pooledCache = null), wa(e)));
  }
  function wl(t) {
    return bm(), Tm(), Em(), Mm();
  }
  function Mm() {
    if (It !== 5) return !1;
    var t = _n,
      e = vu;
    vu = 0;
    var n = Gr(Ji),
      s = z.T,
      o = Z.p;
    try {
      (Z.p = 32 > n ? 32 : n), (z.T = null), (n = Su), (Su = null);
      var u = _n,
        h = Ji;
      if (((It = 0), (Qi = _n = null), (Ji = 0), (bt & 6) !== 0))
        throw Error(l(331));
      var v = bt;
      if (
        ((bt |= 4),
        om(u.current),
        sm(u, u.current, h, n),
        (bt = v),
        Ia(0, !1),
        pe && typeof pe.onPostCommitFiberRoot == "function")
      )
        try {
          pe.onPostCommitFiberRoot(ma, u);
        } catch {}
      return !0;
    } finally {
      (Z.p = o), (z.T = s), Am(t, e);
    }
  }
  function Rm(t, e, n) {
    (e = De(n, e)),
      (e = Wo(t.stateNode, e, 2)),
      (t = An(t, e, 2)),
      t !== null && (ya(t, 2), Pe(t));
  }
  function Dt(t, e, n) {
    if (t.tag === 3) Rm(t, t, n);
    else
      for (; e !== null; ) {
        if (e.tag === 3) {
          Rm(e, t, n);
          break;
        } else if (e.tag === 1) {
          var s = e.stateNode;
          if (
            typeof e.type.getDerivedStateFromError == "function" ||
            (typeof s.componentDidCatch == "function" &&
              (Vn === null || !Vn.has(s)))
          ) {
            (t = De(n, t)),
              (n = jh(2)),
              (s = An(e, n, 2)),
              s !== null && (Nh(n, s, e, t), ya(s, 2), Pe(s));
            break;
          }
        }
        e = e.return;
      }
  }
  function Au(t, e, n) {
    var s = t.pingCache;
    if (s === null) {
      s = t.pingCache = new m1();
      var o = new Set();
      s.set(e, o);
    } else (o = s.get(e)), o === void 0 && ((o = new Set()), s.set(e, o));
    o.has(n) ||
      ((mu = !0), o.add(n), (t = S1.bind(null, t, e, n)), e.then(t, t));
  }
  function S1(t, e, n) {
    var s = t.pingCache;
    s !== null && s.delete(e),
      (t.pingedLanes |= t.suspendedLanes & n),
      (t.warmLanes &= ~n),
      jt === t &&
        (yt & n) === n &&
        (zt === 4 || (zt === 3 && (yt & 62914560) === yt && 300 > qe() - gu)
          ? (bt & 2) === 0 && Fi(t, 0)
          : (pu |= n),
        Pi === yt && (Pi = 0)),
      Pe(t);
  }
  function Dm(t, e) {
    e === 0 && (e = Ef()), (t = wi(t, e)), t !== null && (ya(t, e), Pe(t));
  }
  function x1(t) {
    var e = t.memoizedState,
      n = 0;
    e !== null && (n = e.retryLane), Dm(t, n);
  }
  function b1(t, e) {
    var n = 0;
    switch (t.tag) {
      case 13:
        var s = t.stateNode,
          o = t.memoizedState;
        o !== null && (n = o.retryLane);
        break;
      case 19:
        s = t.stateNode;
        break;
      case 22:
        s = t.stateNode._retryCache;
        break;
      default:
        throw Error(l(314));
    }
    s !== null && s.delete(e), Dm(t, n);
  }
  function T1(t, e) {
    return zr(t, e);
  }
  var Vl = null,
    Wi = null,
    Mu = !1,
    _l = !1,
    Ru = !1,
    oi = 0;
  function Pe(t) {
    t !== Wi &&
      t.next === null &&
      (Wi === null ? (Vl = Wi = t) : (Wi = Wi.next = t)),
      (_l = !0),
      Mu || ((Mu = !0), A1());
  }
  function Ia(t, e) {
    if (!Ru && _l) {
      Ru = !0;
      do
        for (var n = !1, s = Vl; s !== null; ) {
          if (t !== 0) {
            var o = s.pendingLanes;
            if (o === 0) var u = 0;
            else {
              var h = s.suspendedLanes,
                v = s.pingedLanes;
              (u = (1 << (31 - ye(42 | t) + 1)) - 1),
                (u &= o & ~(h & ~v)),
                (u = u & 201326741 ? (u & 201326741) | 1 : u ? u | 2 : 0);
            }
            u !== 0 && ((n = !0), Nm(s, u));
          } else
            (u = yt),
              (u = Gs(
                s,
                s === jt ? u : 0,
                s.cancelPendingCommit !== null || s.timeoutHandle !== -1,
              )),
              (u & 3) === 0 || pa(s, u) || ((n = !0), Nm(s, u));
          s = s.next;
        }
      while (n);
      Ru = !1;
    }
  }
  function E1() {
    Om();
  }
  function Om() {
    _l = Mu = !1;
    var t = 0;
    oi !== 0 && (w1() && (t = oi), (oi = 0));
    for (var e = qe(), n = null, s = Vl; s !== null; ) {
      var o = s.next,
        u = Cm(s, e);
      u === 0
        ? ((s.next = null),
          n === null ? (Vl = o) : (n.next = o),
          o === null && (Wi = n))
        : ((n = s), (t !== 0 || (u & 3) !== 0) && (_l = !0)),
        (s = o);
    }
    Ia(t);
  }
  function Cm(t, e) {
    for (
      var n = t.suspendedLanes,
        s = t.pingedLanes,
        o = t.expirationTimes,
        u = t.pendingLanes & -62914561;
      0 < u;
    ) {
      var h = 31 - ye(u),
        v = 1 << h,
        T = o[h];
      T === -1
        ? ((v & n) === 0 || (v & s) !== 0) && (o[h] = J0(v, e))
        : T <= e && (t.expiredLanes |= v),
        (u &= ~v);
    }
    if (
      ((e = jt),
      (n = yt),
      (n = Gs(
        t,
        t === e ? n : 0,
        t.cancelPendingCommit !== null || t.timeoutHandle !== -1,
      )),
      (s = t.callbackNode),
      n === 0 ||
        (t === e && (Tt === 2 || Tt === 9)) ||
        t.cancelPendingCommit !== null)
    )
      return (
        s !== null && s !== null && Ur(s),
        (t.callbackNode = null),
        (t.callbackPriority = 0)
      );
    if ((n & 3) === 0 || pa(t, n)) {
      if (((e = n & -n), e === t.callbackPriority)) return e;
      switch ((s !== null && Ur(s), Gr(n))) {
        case 2:
        case 8:
          n = xf;
          break;
        case 32:
          n = Us;
          break;
        case 268435456:
          n = bf;
          break;
        default:
          n = Us;
      }
      return (
        (s = jm.bind(null, t)),
        (n = zr(n, s)),
        (t.callbackPriority = e),
        (t.callbackNode = n),
        e
      );
    }
    return (
      s !== null && s !== null && Ur(s),
      (t.callbackPriority = 2),
      (t.callbackNode = null),
      2
    );
  }
  function jm(t, e) {
    if (It !== 0 && It !== 5)
      return (t.callbackNode = null), (t.callbackPriority = 0), null;
    var n = t.callbackNode;
    if (wl() && t.callbackNode !== n) return null;
    var s = yt;
    return (
      (s = Gs(
        t,
        t === jt ? s : 0,
        t.cancelPendingCommit !== null || t.timeoutHandle !== -1,
      )),
      s === 0
        ? null
        : (dm(t, s, e),
          Cm(t, qe()),
          t.callbackNode != null && t.callbackNode === n
            ? jm.bind(null, t)
            : null)
    );
  }
  function Nm(t, e) {
    if (wl()) return null;
    dm(t, e, !0);
  }
  function A1() {
    _1(function () {
      (bt & 6) !== 0 ? zr(Sf, E1) : Om();
    });
  }
  function Du() {
    return oi === 0 && (oi = Tf()), oi;
  }
  function wm(t) {
    return t == null || typeof t == "symbol" || typeof t == "boolean"
      ? null
      : typeof t == "function"
        ? t
        : Zs("" + t);
  }
  function Vm(t, e) {
    var n = e.ownerDocument.createElement("input");
    return (
      (n.name = e.name),
      (n.value = e.value),
      t.id && n.setAttribute("form", t.id),
      e.parentNode.insertBefore(n, e),
      (t = new FormData(t)),
      n.parentNode.removeChild(n),
      t
    );
  }
  function M1(t, e, n, s, o) {
    if (e === "submit" && n && n.stateNode === o) {
      var u = wm((o[ue] || null).action),
        h = s.submitter;
      h &&
        ((e = (e = h[ue] || null)
          ? wm(e.formAction)
          : h.getAttribute("formAction")),
        e !== null && ((u = e), (h = null)));
      var v = new Js("action", "action", null, s, o);
      t.push({
        event: v,
        listeners: [
          {
            instance: null,
            listener: function () {
              if (s.defaultPrevented) {
                if (oi !== 0) {
                  var T = h ? Vm(o, h) : new FormData(o);
                  Po(
                    n,
                    { pending: !0, data: T, method: o.method, action: u },
                    null,
                    T,
                  );
                }
              } else
                typeof u == "function" &&
                  (v.preventDefault(),
                  (T = h ? Vm(o, h) : new FormData(o)),
                  Po(
                    n,
                    { pending: !0, data: T, method: o.method, action: u },
                    u,
                    T,
                  ));
            },
            currentTarget: o,
          },
        ],
      });
    }
  }
  for (var Ou = 0; Ou < fo.length; Ou++) {
    var Cu = fo[Ou],
      R1 = Cu.toLowerCase(),
      D1 = Cu[0].toUpperCase() + Cu.slice(1);
    ze(R1, "on" + D1);
  }
  ze(dd, "onAnimationEnd"),
    ze(hd, "onAnimationIteration"),
    ze(md, "onAnimationStart"),
    ze("dblclick", "onDoubleClick"),
    ze("focusin", "onFocus"),
    ze("focusout", "onBlur"),
    ze(kv, "onTransitionRun"),
    ze(Zv, "onTransitionStart"),
    ze(Kv, "onTransitionCancel"),
    ze(pd, "onTransitionEnd"),
    Ti("onMouseEnter", ["mouseout", "mouseover"]),
    Ti("onMouseLeave", ["mouseout", "mouseover"]),
    Ti("onPointerEnter", ["pointerout", "pointerover"]),
    Ti("onPointerLeave", ["pointerout", "pointerover"]),
    Kn(
      "onChange",
      "change click focusin focusout input keydown keyup selectionchange".split(
        " ",
      ),
    ),
    Kn(
      "onSelect",
      "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
        " ",
      ),
    ),
    Kn("onBeforeInput", ["compositionend", "keypress", "textInput", "paste"]),
    Kn(
      "onCompositionEnd",
      "compositionend focusout keydown keypress keyup mousedown".split(" "),
    ),
    Kn(
      "onCompositionStart",
      "compositionstart focusout keydown keypress keyup mousedown".split(" "),
    ),
    Kn(
      "onCompositionUpdate",
      "compositionupdate focusout keydown keypress keyup mousedown".split(" "),
    );
  var ts =
      "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
        " ",
      ),
    O1 = new Set(
      "beforetoggle cancel close invalid load scroll scrollend toggle"
        .split(" ")
        .concat(ts),
    );
  function _m(t, e) {
    e = (e & 4) !== 0;
    for (var n = 0; n < t.length; n++) {
      var s = t[n],
        o = s.event;
      s = s.listeners;
      t: {
        var u = void 0;
        if (e)
          for (var h = s.length - 1; 0 <= h; h--) {
            var v = s[h],
              T = v.instance,
              C = v.currentTarget;
            if (((v = v.listener), T !== u && o.isPropagationStopped()))
              break t;
            (u = v), (o.currentTarget = C);
            try {
              u(o);
            } catch (B) {
              bl(B);
            }
            (o.currentTarget = null), (u = T);
          }
        else
          for (h = 0; h < s.length; h++) {
            if (
              ((v = s[h]),
              (T = v.instance),
              (C = v.currentTarget),
              (v = v.listener),
              T !== u && o.isPropagationStopped())
            )
              break t;
            (u = v), (o.currentTarget = C);
            try {
              u(o);
            } catch (B) {
              bl(B);
            }
            (o.currentTarget = null), (u = T);
          }
      }
    }
  }
  function ht(t, e) {
    var n = e[Yr];
    n === void 0 && (n = e[Yr] = new Set());
    var s = t + "__bubble";
    n.has(s) || (Lm(e, t, 2, !1), n.add(s));
  }
  function ju(t, e, n) {
    var s = 0;
    e && (s |= 4), Lm(n, t, s, e);
  }
  var Ll = "_reactListening" + Math.random().toString(36).slice(2);
  function Nu(t) {
    if (!t[Ll]) {
      (t[Ll] = !0),
        Of.forEach(function (n) {
          n !== "selectionchange" && (O1.has(n) || ju(n, !1, t), ju(n, !0, t));
        });
      var e = t.nodeType === 9 ? t : t.ownerDocument;
      e === null || e[Ll] || ((e[Ll] = !0), ju("selectionchange", !1, e));
    }
  }
  function Lm(t, e, n, s) {
    switch (sp(e)) {
      case 2:
        var o = eS;
        break;
      case 8:
        o = nS;
        break;
      default:
        o = Zu;
    }
    (n = o.bind(null, e, n, t)),
      (o = void 0),
      !Wr ||
        (e !== "touchstart" && e !== "touchmove" && e !== "wheel") ||
        (o = !0),
      s
        ? o !== void 0
          ? t.addEventListener(e, n, { capture: !0, passive: o })
          : t.addEventListener(e, n, !0)
        : o !== void 0
          ? t.addEventListener(e, n, { passive: o })
          : t.addEventListener(e, n, !1);
  }
  function wu(t, e, n, s, o) {
    var u = s;
    if ((e & 1) === 0 && (e & 2) === 0 && s !== null)
      t: for (;;) {
        if (s === null) return;
        var h = s.tag;
        if (h === 3 || h === 4) {
          var v = s.stateNode.containerInfo;
          if (v === o) break;
          if (h === 4)
            for (h = s.return; h !== null; ) {
              var T = h.tag;
              if ((T === 3 || T === 4) && h.stateNode.containerInfo === o)
                return;
              h = h.return;
            }
          for (; v !== null; ) {
            if (((h = Si(v)), h === null)) return;
            if (((T = h.tag), T === 5 || T === 6 || T === 26 || T === 27)) {
              s = u = h;
              continue t;
            }
            v = v.parentNode;
          }
        }
        s = s.return;
      }
    qf(function () {
      var C = u,
        B = Fr(n),
        Y = [];
      t: {
        var N = yd.get(t);
        if (N !== void 0) {
          var w = Js,
            st = t;
          switch (t) {
            case "keypress":
              if (Ps(n) === 0) break t;
            case "keydown":
            case "keyup":
              w = Tv;
              break;
            case "focusin":
              (st = "focus"), (w = no);
              break;
            case "focusout":
              (st = "blur"), (w = no);
              break;
            case "beforeblur":
            case "afterblur":
              w = no;
              break;
            case "click":
              if (n.button === 2) break t;
            case "auxclick":
            case "dblclick":
            case "mousedown":
            case "mousemove":
            case "mouseup":
            case "mouseout":
            case "mouseover":
            case "contextmenu":
              w = Zf;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              w = cv;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              w = Mv;
              break;
            case dd:
            case hd:
            case md:
              w = hv;
              break;
            case pd:
              w = Dv;
              break;
            case "scroll":
            case "scrollend":
              w = ov;
              break;
            case "wheel":
              w = Cv;
              break;
            case "copy":
            case "cut":
            case "paste":
              w = pv;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              w = Pf;
              break;
            case "toggle":
            case "beforetoggle":
              w = Nv;
          }
          var it = (e & 4) !== 0,
            Rt = !it && (t === "scroll" || t === "scrollend"),
            D = it ? (N !== null ? N + "Capture" : null) : N;
          it = [];
          for (var M = C, O; M !== null; ) {
            var G = M;
            if (
              ((O = G.stateNode),
              (G = G.tag),
              (G !== 5 && G !== 26 && G !== 27) ||
                O === null ||
                D === null ||
                ((G = Sa(M, D)), G != null && it.push(es(M, G, O))),
              Rt)
            )
              break;
            M = M.return;
          }
          0 < it.length &&
            ((N = new w(N, st, null, n, B)),
            Y.push({ event: N, listeners: it }));
        }
      }
      if ((e & 7) === 0) {
        t: {
          if (
            ((N = t === "mouseover" || t === "pointerover"),
            (w = t === "mouseout" || t === "pointerout"),
            N &&
              n !== Jr &&
              (st = n.relatedTarget || n.fromElement) &&
              (Si(st) || st[vi]))
          )
            break t;
          if (
            (w || N) &&
            ((N =
              B.window === B
                ? B
                : (N = B.ownerDocument)
                  ? N.defaultView || N.parentWindow
                  : window),
            w
              ? ((st = n.relatedTarget || n.toElement),
                (w = C),
                (st = st ? Si(st) : null),
                st !== null &&
                  ((Rt = d(st)),
                  (it = st.tag),
                  st !== Rt || (it !== 5 && it !== 27 && it !== 6)) &&
                  (st = null))
              : ((w = null), (st = C)),
            w !== st)
          ) {
            if (
              ((it = Zf),
              (G = "onMouseLeave"),
              (D = "onMouseEnter"),
              (M = "mouse"),
              (t === "pointerout" || t === "pointerover") &&
                ((it = Pf),
                (G = "onPointerLeave"),
                (D = "onPointerEnter"),
                (M = "pointer")),
              (Rt = w == null ? N : va(w)),
              (O = st == null ? N : va(st)),
              (N = new it(G, M + "leave", w, n, B)),
              (N.target = Rt),
              (N.relatedTarget = O),
              (G = null),
              Si(B) === C &&
                ((it = new it(D, M + "enter", st, n, B)),
                (it.target = O),
                (it.relatedTarget = Rt),
                (G = it)),
              (Rt = G),
              w && st)
            )
              e: {
                for (it = w, D = st, M = 0, O = it; O; O = Ii(O)) M++;
                for (O = 0, G = D; G; G = Ii(G)) O++;
                for (; 0 < M - O; ) (it = Ii(it)), M--;
                for (; 0 < O - M; ) (D = Ii(D)), O--;
                for (; M--; ) {
                  if (it === D || (D !== null && it === D.alternate)) break e;
                  (it = Ii(it)), (D = Ii(D));
                }
                it = null;
              }
            else it = null;
            w !== null && zm(Y, N, w, it, !1),
              st !== null && Rt !== null && zm(Y, Rt, st, it, !0);
          }
        }
        t: {
          if (
            ((N = C ? va(C) : window),
            (w = N.nodeName && N.nodeName.toLowerCase()),
            w === "select" || (w === "input" && N.type === "file"))
          )
            var F = ed;
          else if (If(N))
            if (nd) F = Yv;
            else {
              F = Hv;
              var ft = Bv;
            }
          else
            (w = N.nodeName),
              !w ||
              w.toLowerCase() !== "input" ||
              (N.type !== "checkbox" && N.type !== "radio")
                ? C && Qr(C.elementType) && (F = ed)
                : (F = Gv);
          if (F && (F = F(t, C))) {
            td(Y, F, n, B);
            break t;
          }
          ft && ft(t, N, C),
            t === "focusout" &&
              C &&
              N.type === "number" &&
              C.memoizedProps.value != null &&
              Pr(N, "number", N.value);
        }
        switch (((ft = C ? va(C) : window), t)) {
          case "focusin":
            (If(ft) || ft.contentEditable === "true") &&
              ((Ci = ft), (oo = C), (Da = null));
            break;
          case "focusout":
            Da = oo = Ci = null;
            break;
          case "mousedown":
            uo = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            (uo = !1), cd(Y, n, B);
            break;
          case "selectionchange":
            if (Xv) break;
          case "keydown":
          case "keyup":
            cd(Y, n, B);
        }
        var I;
        if (ao)
          t: {
            switch (t) {
              case "compositionstart":
                var at = "onCompositionStart";
                break t;
              case "compositionend":
                at = "onCompositionEnd";
                break t;
              case "compositionupdate":
                at = "onCompositionUpdate";
                break t;
            }
            at = void 0;
          }
        else
          Oi
            ? $f(t, n) && (at = "onCompositionEnd")
            : t === "keydown" &&
              n.keyCode === 229 &&
              (at = "onCompositionStart");
        at &&
          (Qf &&
            n.locale !== "ko" &&
            (Oi || at !== "onCompositionStart"
              ? at === "onCompositionEnd" && Oi && (I = Xf())
              : ((xn = B),
                (Ir = "value" in xn ? xn.value : xn.textContent),
                (Oi = !0))),
          (ft = zl(C, at)),
          0 < ft.length &&
            ((at = new Kf(at, t, null, n, B)),
            Y.push({ event: at, listeners: ft }),
            I ? (at.data = I) : ((I = Wf(n)), I !== null && (at.data = I)))),
          (I = Vv ? _v(t, n) : Lv(t, n)) &&
            ((at = zl(C, "onBeforeInput")),
            0 < at.length &&
              ((ft = new Kf("onBeforeInput", "beforeinput", null, n, B)),
              Y.push({ event: ft, listeners: at }),
              (ft.data = I))),
          M1(Y, t, C, n, B);
      }
      _m(Y, e);
    });
  }
  function es(t, e, n) {
    return { instance: t, listener: e, currentTarget: n };
  }
  function zl(t, e) {
    for (var n = e + "Capture", s = []; t !== null; ) {
      var o = t,
        u = o.stateNode;
      if (
        ((o = o.tag),
        (o !== 5 && o !== 26 && o !== 27) ||
          u === null ||
          ((o = Sa(t, n)),
          o != null && s.unshift(es(t, o, u)),
          (o = Sa(t, e)),
          o != null && s.push(es(t, o, u))),
        t.tag === 3)
      )
        return s;
      t = t.return;
    }
    return [];
  }
  function Ii(t) {
    if (t === null) return null;
    do t = t.return;
    while (t && t.tag !== 5 && t.tag !== 27);
    return t || null;
  }
  function zm(t, e, n, s, o) {
    for (var u = e._reactName, h = []; n !== null && n !== s; ) {
      var v = n,
        T = v.alternate,
        C = v.stateNode;
      if (((v = v.tag), T !== null && T === s)) break;
      (v !== 5 && v !== 26 && v !== 27) ||
        C === null ||
        ((T = C),
        o
          ? ((C = Sa(n, u)), C != null && h.unshift(es(n, C, T)))
          : o || ((C = Sa(n, u)), C != null && h.push(es(n, C, T)))),
        (n = n.return);
    }
    h.length !== 0 && t.push({ event: e, listeners: h });
  }
  var C1 = /\r\n?/g,
    j1 = /\u0000|\uFFFD/g;
  function Um(t) {
    return (typeof t == "string" ? t : "" + t)
      .replace(
        C1,
        `
`,
      )
      .replace(j1, "");
  }
  function Bm(t, e) {
    return (e = Um(e)), Um(t) === e;
  }
  function Ul() {}
  function Mt(t, e, n, s, o, u) {
    switch (n) {
      case "children":
        typeof s == "string"
          ? e === "body" || (e === "textarea" && s === "") || Mi(t, s)
          : (typeof s == "number" || typeof s == "bigint") &&
            e !== "body" &&
            Mi(t, "" + s);
        break;
      case "className":
        qs(t, "class", s);
        break;
      case "tabIndex":
        qs(t, "tabindex", s);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        qs(t, n, s);
        break;
      case "style":
        Gf(t, s, u);
        break;
      case "data":
        if (e !== "object") {
          qs(t, "data", s);
          break;
        }
      case "src":
      case "href":
        if (s === "" && (e !== "a" || n !== "href")) {
          t.removeAttribute(n);
          break;
        }
        if (
          s == null ||
          typeof s == "function" ||
          typeof s == "symbol" ||
          typeof s == "boolean"
        ) {
          t.removeAttribute(n);
          break;
        }
        (s = Zs("" + s)), t.setAttribute(n, s);
        break;
      case "action":
      case "formAction":
        if (typeof s == "function") {
          t.setAttribute(
            n,
            "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')",
          );
          break;
        } else
          typeof u == "function" &&
            (n === "formAction"
              ? (e !== "input" && Mt(t, e, "name", o.name, o, null),
                Mt(t, e, "formEncType", o.formEncType, o, null),
                Mt(t, e, "formMethod", o.formMethod, o, null),
                Mt(t, e, "formTarget", o.formTarget, o, null))
              : (Mt(t, e, "encType", o.encType, o, null),
                Mt(t, e, "method", o.method, o, null),
                Mt(t, e, "target", o.target, o, null)));
        if (s == null || typeof s == "symbol" || typeof s == "boolean") {
          t.removeAttribute(n);
          break;
        }
        (s = Zs("" + s)), t.setAttribute(n, s);
        break;
      case "onClick":
        s != null && (t.onclick = Ul);
        break;
      case "onScroll":
        s != null && ht("scroll", t);
        break;
      case "onScrollEnd":
        s != null && ht("scrollend", t);
        break;
      case "dangerouslySetInnerHTML":
        if (s != null) {
          if (typeof s != "object" || !("__html" in s)) throw Error(l(61));
          if (((n = s.__html), n != null)) {
            if (o.children != null) throw Error(l(60));
            t.innerHTML = n;
          }
        }
        break;
      case "multiple":
        t.multiple = s && typeof s != "function" && typeof s != "symbol";
        break;
      case "muted":
        t.muted = s && typeof s != "function" && typeof s != "symbol";
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "ref":
        break;
      case "autoFocus":
        break;
      case "xlinkHref":
        if (
          s == null ||
          typeof s == "function" ||
          typeof s == "boolean" ||
          typeof s == "symbol"
        ) {
          t.removeAttribute("xlink:href");
          break;
        }
        (n = Zs("" + s)),
          t.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", n);
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        s != null && typeof s != "function" && typeof s != "symbol"
          ? t.setAttribute(n, "" + s)
          : t.removeAttribute(n);
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        s && typeof s != "function" && typeof s != "symbol"
          ? t.setAttribute(n, "")
          : t.removeAttribute(n);
        break;
      case "capture":
      case "download":
        s === !0
          ? t.setAttribute(n, "")
          : s !== !1 &&
              s != null &&
              typeof s != "function" &&
              typeof s != "symbol"
            ? t.setAttribute(n, s)
            : t.removeAttribute(n);
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        s != null &&
        typeof s != "function" &&
        typeof s != "symbol" &&
        !isNaN(s) &&
        1 <= s
          ? t.setAttribute(n, s)
          : t.removeAttribute(n);
        break;
      case "rowSpan":
      case "start":
        s == null || typeof s == "function" || typeof s == "symbol" || isNaN(s)
          ? t.removeAttribute(n)
          : t.setAttribute(n, s);
        break;
      case "popover":
        ht("beforetoggle", t), ht("toggle", t), Ys(t, "popover", s);
        break;
      case "xlinkActuate":
        We(t, "http://www.w3.org/1999/xlink", "xlink:actuate", s);
        break;
      case "xlinkArcrole":
        We(t, "http://www.w3.org/1999/xlink", "xlink:arcrole", s);
        break;
      case "xlinkRole":
        We(t, "http://www.w3.org/1999/xlink", "xlink:role", s);
        break;
      case "xlinkShow":
        We(t, "http://www.w3.org/1999/xlink", "xlink:show", s);
        break;
      case "xlinkTitle":
        We(t, "http://www.w3.org/1999/xlink", "xlink:title", s);
        break;
      case "xlinkType":
        We(t, "http://www.w3.org/1999/xlink", "xlink:type", s);
        break;
      case "xmlBase":
        We(t, "http://www.w3.org/XML/1998/namespace", "xml:base", s);
        break;
      case "xmlLang":
        We(t, "http://www.w3.org/XML/1998/namespace", "xml:lang", s);
        break;
      case "xmlSpace":
        We(t, "http://www.w3.org/XML/1998/namespace", "xml:space", s);
        break;
      case "is":
        Ys(t, "is", s);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < n.length) ||
          (n[0] !== "o" && n[0] !== "O") ||
          (n[1] !== "n" && n[1] !== "N")) &&
          ((n = lv.get(n) || n), Ys(t, n, s));
    }
  }
  function Vu(t, e, n, s, o, u) {
    switch (n) {
      case "style":
        Gf(t, s, u);
        break;
      case "dangerouslySetInnerHTML":
        if (s != null) {
          if (typeof s != "object" || !("__html" in s)) throw Error(l(61));
          if (((n = s.__html), n != null)) {
            if (o.children != null) throw Error(l(60));
            t.innerHTML = n;
          }
        }
        break;
      case "children":
        typeof s == "string"
          ? Mi(t, s)
          : (typeof s == "number" || typeof s == "bigint") && Mi(t, "" + s);
        break;
      case "onScroll":
        s != null && ht("scroll", t);
        break;
      case "onScrollEnd":
        s != null && ht("scrollend", t);
        break;
      case "onClick":
        s != null && (t.onclick = Ul);
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "innerHTML":
      case "ref":
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        if (!Cf.hasOwnProperty(n))
          t: {
            if (
              n[0] === "o" &&
              n[1] === "n" &&
              ((o = n.endsWith("Capture")),
              (e = n.slice(2, o ? n.length - 7 : void 0)),
              (u = t[ue] || null),
              (u = u != null ? u[n] : null),
              typeof u == "function" && t.removeEventListener(e, u, o),
              typeof s == "function")
            ) {
              typeof u != "function" &&
                u !== null &&
                (n in t
                  ? (t[n] = null)
                  : t.hasAttribute(n) && t.removeAttribute(n)),
                t.addEventListener(e, s, o);
              break t;
            }
            n in t
              ? (t[n] = s)
              : s === !0
                ? t.setAttribute(n, "")
                : Ys(t, n, s);
          }
    }
  }
  function te(t, e, n) {
    switch (e) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "img":
        ht("error", t), ht("load", t);
        var s = !1,
          o = !1,
          u;
        for (u in n)
          if (n.hasOwnProperty(u)) {
            var h = n[u];
            if (h != null)
              switch (u) {
                case "src":
                  s = !0;
                  break;
                case "srcSet":
                  o = !0;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(l(137, e));
                default:
                  Mt(t, e, u, h, n, null);
              }
          }
        o && Mt(t, e, "srcSet", n.srcSet, n, null),
          s && Mt(t, e, "src", n.src, n, null);
        return;
      case "input":
        ht("invalid", t);
        var v = (u = h = o = null),
          T = null,
          C = null;
        for (s in n)
          if (n.hasOwnProperty(s)) {
            var B = n[s];
            if (B != null)
              switch (s) {
                case "name":
                  o = B;
                  break;
                case "type":
                  h = B;
                  break;
                case "checked":
                  T = B;
                  break;
                case "defaultChecked":
                  C = B;
                  break;
                case "value":
                  u = B;
                  break;
                case "defaultValue":
                  v = B;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (B != null) throw Error(l(137, e));
                  break;
                default:
                  Mt(t, e, s, B, n, null);
              }
          }
        zf(t, u, v, T, C, h, o, !1), Xs(t);
        return;
      case "select":
        ht("invalid", t), (s = h = u = null);
        for (o in n)
          if (n.hasOwnProperty(o) && ((v = n[o]), v != null))
            switch (o) {
              case "value":
                u = v;
                break;
              case "defaultValue":
                h = v;
                break;
              case "multiple":
                s = v;
              default:
                Mt(t, e, o, v, n, null);
            }
        (e = u),
          (n = h),
          (t.multiple = !!s),
          e != null ? Ai(t, !!s, e, !1) : n != null && Ai(t, !!s, n, !0);
        return;
      case "textarea":
        ht("invalid", t), (u = o = s = null);
        for (h in n)
          if (n.hasOwnProperty(h) && ((v = n[h]), v != null))
            switch (h) {
              case "value":
                s = v;
                break;
              case "defaultValue":
                o = v;
                break;
              case "children":
                u = v;
                break;
              case "dangerouslySetInnerHTML":
                if (v != null) throw Error(l(91));
                break;
              default:
                Mt(t, e, h, v, n, null);
            }
        Bf(t, s, o, u), Xs(t);
        return;
      case "option":
        for (T in n)
          n.hasOwnProperty(T) &&
            ((s = n[T]), s != null) &&
            (T === "selected"
              ? (t.selected =
                  s && typeof s != "function" && typeof s != "symbol")
              : Mt(t, e, T, s, n, null));
        return;
      case "dialog":
        ht("beforetoggle", t), ht("toggle", t), ht("cancel", t), ht("close", t);
        break;
      case "iframe":
      case "object":
        ht("load", t);
        break;
      case "video":
      case "audio":
        for (s = 0; s < ts.length; s++) ht(ts[s], t);
        break;
      case "image":
        ht("error", t), ht("load", t);
        break;
      case "details":
        ht("toggle", t);
        break;
      case "embed":
      case "source":
      case "link":
        ht("error", t), ht("load", t);
      case "area":
      case "base":
      case "br":
      case "col":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "track":
      case "wbr":
      case "menuitem":
        for (C in n)
          if (n.hasOwnProperty(C) && ((s = n[C]), s != null))
            switch (C) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(l(137, e));
              default:
                Mt(t, e, C, s, n, null);
            }
        return;
      default:
        if (Qr(e)) {
          for (B in n)
            n.hasOwnProperty(B) &&
              ((s = n[B]), s !== void 0 && Vu(t, e, B, s, n, void 0));
          return;
        }
    }
    for (v in n)
      n.hasOwnProperty(v) && ((s = n[v]), s != null && Mt(t, e, v, s, n, null));
  }
  function N1(t, e, n, s) {
    switch (e) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "input":
        var o = null,
          u = null,
          h = null,
          v = null,
          T = null,
          C = null,
          B = null;
        for (w in n) {
          var Y = n[w];
          if (n.hasOwnProperty(w) && Y != null)
            switch (w) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                T = Y;
              default:
                s.hasOwnProperty(w) || Mt(t, e, w, null, s, Y);
            }
        }
        for (var N in s) {
          var w = s[N];
          if (((Y = n[N]), s.hasOwnProperty(N) && (w != null || Y != null)))
            switch (N) {
              case "type":
                u = w;
                break;
              case "name":
                o = w;
                break;
              case "checked":
                C = w;
                break;
              case "defaultChecked":
                B = w;
                break;
              case "value":
                h = w;
                break;
              case "defaultValue":
                v = w;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (w != null) throw Error(l(137, e));
                break;
              default:
                w !== Y && Mt(t, e, N, w, s, Y);
            }
        }
        Kr(t, h, v, T, C, B, u, o);
        return;
      case "select":
        w = h = v = N = null;
        for (u in n)
          if (((T = n[u]), n.hasOwnProperty(u) && T != null))
            switch (u) {
              case "value":
                break;
              case "multiple":
                w = T;
              default:
                s.hasOwnProperty(u) || Mt(t, e, u, null, s, T);
            }
        for (o in s)
          if (
            ((u = s[o]),
            (T = n[o]),
            s.hasOwnProperty(o) && (u != null || T != null))
          )
            switch (o) {
              case "value":
                N = u;
                break;
              case "defaultValue":
                v = u;
                break;
              case "multiple":
                h = u;
              default:
                u !== T && Mt(t, e, o, u, s, T);
            }
        (e = v),
          (n = h),
          (s = w),
          N != null
            ? Ai(t, !!n, N, !1)
            : !!s != !!n &&
              (e != null ? Ai(t, !!n, e, !0) : Ai(t, !!n, n ? [] : "", !1));
        return;
      case "textarea":
        w = N = null;
        for (v in n)
          if (
            ((o = n[v]),
            n.hasOwnProperty(v) && o != null && !s.hasOwnProperty(v))
          )
            switch (v) {
              case "value":
                break;
              case "children":
                break;
              default:
                Mt(t, e, v, null, s, o);
            }
        for (h in s)
          if (
            ((o = s[h]),
            (u = n[h]),
            s.hasOwnProperty(h) && (o != null || u != null))
          )
            switch (h) {
              case "value":
                N = o;
                break;
              case "defaultValue":
                w = o;
                break;
              case "children":
                break;
              case "dangerouslySetInnerHTML":
                if (o != null) throw Error(l(91));
                break;
              default:
                o !== u && Mt(t, e, h, o, s, u);
            }
        Uf(t, N, w);
        return;
      case "option":
        for (var st in n)
          (N = n[st]),
            n.hasOwnProperty(st) &&
              N != null &&
              !s.hasOwnProperty(st) &&
              (st === "selected"
                ? (t.selected = !1)
                : Mt(t, e, st, null, s, N));
        for (T in s)
          (N = s[T]),
            (w = n[T]),
            s.hasOwnProperty(T) &&
              N !== w &&
              (N != null || w != null) &&
              (T === "selected"
                ? (t.selected =
                    N && typeof N != "function" && typeof N != "symbol")
                : Mt(t, e, T, N, s, w));
        return;
      case "img":
      case "link":
      case "area":
      case "base":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "source":
      case "track":
      case "wbr":
      case "menuitem":
        for (var it in n)
          (N = n[it]),
            n.hasOwnProperty(it) &&
              N != null &&
              !s.hasOwnProperty(it) &&
              Mt(t, e, it, null, s, N);
        for (C in s)
          if (
            ((N = s[C]),
            (w = n[C]),
            s.hasOwnProperty(C) && N !== w && (N != null || w != null))
          )
            switch (C) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (N != null) throw Error(l(137, e));
                break;
              default:
                Mt(t, e, C, N, s, w);
            }
        return;
      default:
        if (Qr(e)) {
          for (var Rt in n)
            (N = n[Rt]),
              n.hasOwnProperty(Rt) &&
                N !== void 0 &&
                !s.hasOwnProperty(Rt) &&
                Vu(t, e, Rt, void 0, s, N);
          for (B in s)
            (N = s[B]),
              (w = n[B]),
              !s.hasOwnProperty(B) ||
                N === w ||
                (N === void 0 && w === void 0) ||
                Vu(t, e, B, N, s, w);
          return;
        }
    }
    for (var D in n)
      (N = n[D]),
        n.hasOwnProperty(D) &&
          N != null &&
          !s.hasOwnProperty(D) &&
          Mt(t, e, D, null, s, N);
    for (Y in s)
      (N = s[Y]),
        (w = n[Y]),
        !s.hasOwnProperty(Y) ||
          N === w ||
          (N == null && w == null) ||
          Mt(t, e, Y, N, s, w);
  }
  var _u = null,
    Lu = null;
  function Bl(t) {
    return t.nodeType === 9 ? t : t.ownerDocument;
  }
  function Hm(t) {
    switch (t) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function Gm(t, e) {
    if (t === 0)
      switch (e) {
        case "svg":
          return 1;
        case "math":
          return 2;
        default:
          return 0;
      }
    return t === 1 && e === "foreignObject" ? 0 : t;
  }
  function zu(t, e) {
    return (
      t === "textarea" ||
      t === "noscript" ||
      typeof e.children == "string" ||
      typeof e.children == "number" ||
      typeof e.children == "bigint" ||
      (typeof e.dangerouslySetInnerHTML == "object" &&
        e.dangerouslySetInnerHTML !== null &&
        e.dangerouslySetInnerHTML.__html != null)
    );
  }
  var Uu = null;
  function w1() {
    var t = window.event;
    return t && t.type === "popstate"
      ? t === Uu
        ? !1
        : ((Uu = t), !0)
      : ((Uu = null), !1);
  }
  var Ym = typeof setTimeout == "function" ? setTimeout : void 0,
    V1 = typeof clearTimeout == "function" ? clearTimeout : void 0,
    qm = typeof Promise == "function" ? Promise : void 0,
    _1 =
      typeof queueMicrotask == "function"
        ? queueMicrotask
        : typeof qm < "u"
          ? function (t) {
              return qm.resolve(null).then(t).catch(L1);
            }
          : Ym;
  function L1(t) {
    setTimeout(function () {
      throw t;
    });
  }
  function zn(t) {
    return t === "head";
  }
  function Xm(t, e) {
    var n = e,
      s = 0,
      o = 0;
    do {
      var u = n.nextSibling;
      if ((t.removeChild(n), u && u.nodeType === 8))
        if (((n = u.data), n === "/$")) {
          if (0 < s && 8 > s) {
            n = s;
            var h = t.ownerDocument;
            if ((n & 1 && ns(h.documentElement), n & 2 && ns(h.body), n & 4))
              for (n = h.head, ns(n), h = n.firstChild; h; ) {
                var v = h.nextSibling,
                  T = h.nodeName;
                h[ga] ||
                  T === "SCRIPT" ||
                  T === "STYLE" ||
                  (T === "LINK" && h.rel.toLowerCase() === "stylesheet") ||
                  n.removeChild(h),
                  (h = v);
              }
          }
          if (o === 0) {
            t.removeChild(u), cs(e);
            return;
          }
          o--;
        } else
          n === "$" || n === "$?" || n === "$!"
            ? o++
            : (s = n.charCodeAt(0) - 48);
      else s = 0;
      n = u;
    } while (n);
    cs(e);
  }
  function Bu(t) {
    var e = t.firstChild;
    for (e && e.nodeType === 10 && (e = e.nextSibling); e; ) {
      var n = e;
      switch (((e = e.nextSibling), n.nodeName)) {
        case "HTML":
        case "HEAD":
        case "BODY":
          Bu(n), qr(n);
          continue;
        case "SCRIPT":
        case "STYLE":
          continue;
        case "LINK":
          if (n.rel.toLowerCase() === "stylesheet") continue;
      }
      t.removeChild(n);
    }
  }
  function z1(t, e, n, s) {
    for (; t.nodeType === 1; ) {
      var o = n;
      if (t.nodeName.toLowerCase() !== e.toLowerCase()) {
        if (!s && (t.nodeName !== "INPUT" || t.type !== "hidden")) break;
      } else if (s) {
        if (!t[ga])
          switch (e) {
            case "meta":
              if (!t.hasAttribute("itemprop")) break;
              return t;
            case "link":
              if (
                ((u = t.getAttribute("rel")),
                u === "stylesheet" && t.hasAttribute("data-precedence"))
              )
                break;
              if (
                u !== o.rel ||
                t.getAttribute("href") !==
                  (o.href == null || o.href === "" ? null : o.href) ||
                t.getAttribute("crossorigin") !==
                  (o.crossOrigin == null ? null : o.crossOrigin) ||
                t.getAttribute("title") !== (o.title == null ? null : o.title)
              )
                break;
              return t;
            case "style":
              if (t.hasAttribute("data-precedence")) break;
              return t;
            case "script":
              if (
                ((u = t.getAttribute("src")),
                (u !== (o.src == null ? null : o.src) ||
                  t.getAttribute("type") !== (o.type == null ? null : o.type) ||
                  t.getAttribute("crossorigin") !==
                    (o.crossOrigin == null ? null : o.crossOrigin)) &&
                  u &&
                  t.hasAttribute("async") &&
                  !t.hasAttribute("itemprop"))
              )
                break;
              return t;
            default:
              return t;
          }
      } else if (e === "input" && t.type === "hidden") {
        var u = o.name == null ? null : "" + o.name;
        if (o.type === "hidden" && t.getAttribute("name") === u) return t;
      } else return t;
      if (((t = Be(t.nextSibling)), t === null)) break;
    }
    return null;
  }
  function U1(t, e, n) {
    if (e === "") return null;
    for (; t.nodeType !== 3; )
      if (
        ((t.nodeType !== 1 || t.nodeName !== "INPUT" || t.type !== "hidden") &&
          !n) ||
        ((t = Be(t.nextSibling)), t === null)
      )
        return null;
    return t;
  }
  function Hu(t) {
    return (
      t.data === "$!" ||
      (t.data === "$?" && t.ownerDocument.readyState === "complete")
    );
  }
  function B1(t, e) {
    var n = t.ownerDocument;
    if (t.data !== "$?" || n.readyState === "complete") e();
    else {
      var s = function () {
        e(), n.removeEventListener("DOMContentLoaded", s);
      };
      n.addEventListener("DOMContentLoaded", s), (t._reactRetry = s);
    }
  }
  function Be(t) {
    for (; t != null; t = t.nextSibling) {
      var e = t.nodeType;
      if (e === 1 || e === 3) break;
      if (e === 8) {
        if (
          ((e = t.data),
          e === "$" || e === "$!" || e === "$?" || e === "F!" || e === "F")
        )
          break;
        if (e === "/$") return null;
      }
    }
    return t;
  }
  var Gu = null;
  function km(t) {
    t = t.previousSibling;
    for (var e = 0; t; ) {
      if (t.nodeType === 8) {
        var n = t.data;
        if (n === "$" || n === "$!" || n === "$?") {
          if (e === 0) return t;
          e--;
        } else n === "/$" && e++;
      }
      t = t.previousSibling;
    }
    return null;
  }
  function Zm(t, e, n) {
    switch (((e = Bl(n)), t)) {
      case "html":
        if (((t = e.documentElement), !t)) throw Error(l(452));
        return t;
      case "head":
        if (((t = e.head), !t)) throw Error(l(453));
        return t;
      case "body":
        if (((t = e.body), !t)) throw Error(l(454));
        return t;
      default:
        throw Error(l(451));
    }
  }
  function ns(t) {
    for (var e = t.attributes; e.length; ) t.removeAttributeNode(e[0]);
    qr(t);
  }
  var Ve = new Map(),
    Km = new Set();
  function Hl(t) {
    return typeof t.getRootNode == "function"
      ? t.getRootNode()
      : t.nodeType === 9
        ? t
        : t.ownerDocument;
  }
  var hn = Z.d;
  Z.d = { f: H1, r: G1, D: Y1, C: q1, L: X1, m: k1, X: K1, S: Z1, M: P1 };
  function H1() {
    var t = hn.f(),
      e = jl();
    return t || e;
  }
  function G1(t) {
    var e = xi(t);
    e !== null && e.tag === 5 && e.type === "form" ? dh(e) : hn.r(t);
  }
  var ta = typeof document > "u" ? null : document;
  function Pm(t, e, n) {
    var s = ta;
    if (s && typeof e == "string" && e) {
      var o = Re(e);
      (o = 'link[rel="' + t + '"][href="' + o + '"]'),
        typeof n == "string" && (o += '[crossorigin="' + n + '"]'),
        Km.has(o) ||
          (Km.add(o),
          (t = { rel: t, crossOrigin: n, href: e }),
          s.querySelector(o) === null &&
            ((e = s.createElement("link")),
            te(e, "link", t),
            Pt(e),
            s.head.appendChild(e)));
    }
  }
  function Y1(t) {
    hn.D(t), Pm("dns-prefetch", t, null);
  }
  function q1(t, e) {
    hn.C(t, e), Pm("preconnect", t, e);
  }
  function X1(t, e, n) {
    hn.L(t, e, n);
    var s = ta;
    if (s && t && e) {
      var o = 'link[rel="preload"][as="' + Re(e) + '"]';
      e === "image" && n && n.imageSrcSet
        ? ((o += '[imagesrcset="' + Re(n.imageSrcSet) + '"]'),
          typeof n.imageSizes == "string" &&
            (o += '[imagesizes="' + Re(n.imageSizes) + '"]'))
        : (o += '[href="' + Re(t) + '"]');
      var u = o;
      switch (e) {
        case "style":
          u = ea(t);
          break;
        case "script":
          u = na(t);
      }
      Ve.has(u) ||
        ((t = g(
          {
            rel: "preload",
            href: e === "image" && n && n.imageSrcSet ? void 0 : t,
            as: e,
          },
          n,
        )),
        Ve.set(u, t),
        s.querySelector(o) !== null ||
          (e === "style" && s.querySelector(is(u))) ||
          (e === "script" && s.querySelector(as(u))) ||
          ((e = s.createElement("link")),
          te(e, "link", t),
          Pt(e),
          s.head.appendChild(e)));
    }
  }
  function k1(t, e) {
    hn.m(t, e);
    var n = ta;
    if (n && t) {
      var s = e && typeof e.as == "string" ? e.as : "script",
        o =
          'link[rel="modulepreload"][as="' + Re(s) + '"][href="' + Re(t) + '"]',
        u = o;
      switch (s) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          u = na(t);
      }
      if (
        !Ve.has(u) &&
        ((t = g({ rel: "modulepreload", href: t }, e)),
        Ve.set(u, t),
        n.querySelector(o) === null)
      ) {
        switch (s) {
          case "audioworklet":
          case "paintworklet":
          case "serviceworker":
          case "sharedworker":
          case "worker":
          case "script":
            if (n.querySelector(as(u))) return;
        }
        (s = n.createElement("link")),
          te(s, "link", t),
          Pt(s),
          n.head.appendChild(s);
      }
    }
  }
  function Z1(t, e, n) {
    hn.S(t, e, n);
    var s = ta;
    if (s && t) {
      var o = bi(s).hoistableStyles,
        u = ea(t);
      e = e || "default";
      var h = o.get(u);
      if (!h) {
        var v = { loading: 0, preload: null };
        if ((h = s.querySelector(is(u)))) v.loading = 5;
        else {
          (t = g({ rel: "stylesheet", href: t, "data-precedence": e }, n)),
            (n = Ve.get(u)) && Yu(t, n);
          var T = (h = s.createElement("link"));
          Pt(T),
            te(T, "link", t),
            (T._p = new Promise(function (C, B) {
              (T.onload = C), (T.onerror = B);
            })),
            T.addEventListener("load", function () {
              v.loading |= 1;
            }),
            T.addEventListener("error", function () {
              v.loading |= 2;
            }),
            (v.loading |= 4),
            Gl(h, e, s);
        }
        (h = { type: "stylesheet", instance: h, count: 1, state: v }),
          o.set(u, h);
      }
    }
  }
  function K1(t, e) {
    hn.X(t, e);
    var n = ta;
    if (n && t) {
      var s = bi(n).hoistableScripts,
        o = na(t),
        u = s.get(o);
      u ||
        ((u = n.querySelector(as(o))),
        u ||
          ((t = g({ src: t, async: !0 }, e)),
          (e = Ve.get(o)) && qu(t, e),
          (u = n.createElement("script")),
          Pt(u),
          te(u, "link", t),
          n.head.appendChild(u)),
        (u = { type: "script", instance: u, count: 1, state: null }),
        s.set(o, u));
    }
  }
  function P1(t, e) {
    hn.M(t, e);
    var n = ta;
    if (n && t) {
      var s = bi(n).hoistableScripts,
        o = na(t),
        u = s.get(o);
      u ||
        ((u = n.querySelector(as(o))),
        u ||
          ((t = g({ src: t, async: !0, type: "module" }, e)),
          (e = Ve.get(o)) && qu(t, e),
          (u = n.createElement("script")),
          Pt(u),
          te(u, "link", t),
          n.head.appendChild(u)),
        (u = { type: "script", instance: u, count: 1, state: null }),
        s.set(o, u));
    }
  }
  function Qm(t, e, n, s) {
    var o = (o = rt.current) ? Hl(o) : null;
    if (!o) throw Error(l(446));
    switch (t) {
      case "meta":
      case "title":
        return null;
      case "style":
        return typeof n.precedence == "string" && typeof n.href == "string"
          ? ((e = ea(n.href)),
            (n = bi(o).hoistableStyles),
            (s = n.get(e)),
            s ||
              ((s = { type: "style", instance: null, count: 0, state: null }),
              n.set(e, s)),
            s)
          : { type: "void", instance: null, count: 0, state: null };
      case "link":
        if (
          n.rel === "stylesheet" &&
          typeof n.href == "string" &&
          typeof n.precedence == "string"
        ) {
          t = ea(n.href);
          var u = bi(o).hoistableStyles,
            h = u.get(t);
          if (
            (h ||
              ((o = o.ownerDocument || o),
              (h = {
                type: "stylesheet",
                instance: null,
                count: 0,
                state: { loading: 0, preload: null },
              }),
              u.set(t, h),
              (u = o.querySelector(is(t))) &&
                !u._p &&
                ((h.instance = u), (h.state.loading = 5)),
              Ve.has(t) ||
                ((n = {
                  rel: "preload",
                  as: "style",
                  href: n.href,
                  crossOrigin: n.crossOrigin,
                  integrity: n.integrity,
                  media: n.media,
                  hrefLang: n.hrefLang,
                  referrerPolicy: n.referrerPolicy,
                }),
                Ve.set(t, n),
                u || Q1(o, t, n, h.state))),
            e && s === null)
          )
            throw Error(l(528, ""));
          return h;
        }
        if (e && s !== null) throw Error(l(529, ""));
        return null;
      case "script":
        return (
          (e = n.async),
          (n = n.src),
          typeof n == "string" &&
          e &&
          typeof e != "function" &&
          typeof e != "symbol"
            ? ((e = na(n)),
              (n = bi(o).hoistableScripts),
              (s = n.get(e)),
              s ||
                ((s = {
                  type: "script",
                  instance: null,
                  count: 0,
                  state: null,
                }),
                n.set(e, s)),
              s)
            : { type: "void", instance: null, count: 0, state: null }
        );
      default:
        throw Error(l(444, t));
    }
  }
  function ea(t) {
    return 'href="' + Re(t) + '"';
  }
  function is(t) {
    return 'link[rel="stylesheet"][' + t + "]";
  }
  function Jm(t) {
    return g({}, t, { "data-precedence": t.precedence, precedence: null });
  }
  function Q1(t, e, n, s) {
    t.querySelector('link[rel="preload"][as="style"][' + e + "]")
      ? (s.loading = 1)
      : ((e = t.createElement("link")),
        (s.preload = e),
        e.addEventListener("load", function () {
          return (s.loading |= 1);
        }),
        e.addEventListener("error", function () {
          return (s.loading |= 2);
        }),
        te(e, "link", n),
        Pt(e),
        t.head.appendChild(e));
  }
  function na(t) {
    return '[src="' + Re(t) + '"]';
  }
  function as(t) {
    return "script[async]" + t;
  }
  function Fm(t, e, n) {
    if ((e.count++, e.instance === null))
      switch (e.type) {
        case "style":
          var s = t.querySelector('style[data-href~="' + Re(n.href) + '"]');
          if (s) return (e.instance = s), Pt(s), s;
          var o = g({}, n, {
            "data-href": n.href,
            "data-precedence": n.precedence,
            href: null,
            precedence: null,
          });
          return (
            (s = (t.ownerDocument || t).createElement("style")),
            Pt(s),
            te(s, "style", o),
            Gl(s, n.precedence, t),
            (e.instance = s)
          );
        case "stylesheet":
          o = ea(n.href);
          var u = t.querySelector(is(o));
          if (u) return (e.state.loading |= 4), (e.instance = u), Pt(u), u;
          (s = Jm(n)),
            (o = Ve.get(o)) && Yu(s, o),
            (u = (t.ownerDocument || t).createElement("link")),
            Pt(u);
          var h = u;
          return (
            (h._p = new Promise(function (v, T) {
              (h.onload = v), (h.onerror = T);
            })),
            te(u, "link", s),
            (e.state.loading |= 4),
            Gl(u, n.precedence, t),
            (e.instance = u)
          );
        case "script":
          return (
            (u = na(n.src)),
            (o = t.querySelector(as(u)))
              ? ((e.instance = o), Pt(o), o)
              : ((s = n),
                (o = Ve.get(u)) && ((s = g({}, n)), qu(s, o)),
                (t = t.ownerDocument || t),
                (o = t.createElement("script")),
                Pt(o),
                te(o, "link", s),
                t.head.appendChild(o),
                (e.instance = o))
          );
        case "void":
          return null;
        default:
          throw Error(l(443, e.type));
      }
    else
      e.type === "stylesheet" &&
        (e.state.loading & 4) === 0 &&
        ((s = e.instance), (e.state.loading |= 4), Gl(s, n.precedence, t));
    return e.instance;
  }
  function Gl(t, e, n) {
    for (
      var s = n.querySelectorAll(
          'link[rel="stylesheet"][data-precedence],style[data-precedence]',
        ),
        o = s.length ? s[s.length - 1] : null,
        u = o,
        h = 0;
      h < s.length;
      h++
    ) {
      var v = s[h];
      if (v.dataset.precedence === e) u = v;
      else if (u !== o) break;
    }
    u
      ? u.parentNode.insertBefore(t, u.nextSibling)
      : ((e = n.nodeType === 9 ? n.head : n), e.insertBefore(t, e.firstChild));
  }
  function Yu(t, e) {
    t.crossOrigin == null && (t.crossOrigin = e.crossOrigin),
      t.referrerPolicy == null && (t.referrerPolicy = e.referrerPolicy),
      t.title == null && (t.title = e.title);
  }
  function qu(t, e) {
    t.crossOrigin == null && (t.crossOrigin = e.crossOrigin),
      t.referrerPolicy == null && (t.referrerPolicy = e.referrerPolicy),
      t.integrity == null && (t.integrity = e.integrity);
  }
  var Yl = null;
  function $m(t, e, n) {
    if (Yl === null) {
      var s = new Map(),
        o = (Yl = new Map());
      o.set(n, s);
    } else (o = Yl), (s = o.get(n)), s || ((s = new Map()), o.set(n, s));
    if (s.has(t)) return s;
    for (
      s.set(t, null), n = n.getElementsByTagName(t), o = 0;
      o < n.length;
      o++
    ) {
      var u = n[o];
      if (
        !(
          u[ga] ||
          u[ie] ||
          (t === "link" && u.getAttribute("rel") === "stylesheet")
        ) &&
        u.namespaceURI !== "http://www.w3.org/2000/svg"
      ) {
        var h = u.getAttribute(e) || "";
        h = t + h;
        var v = s.get(h);
        v ? v.push(u) : s.set(h, [u]);
      }
    }
    return s;
  }
  function Wm(t, e, n) {
    (t = t.ownerDocument || t),
      t.head.insertBefore(
        n,
        e === "title" ? t.querySelector("head > title") : null,
      );
  }
  function J1(t, e, n) {
    if (n === 1 || e.itemProp != null) return !1;
    switch (t) {
      case "meta":
      case "title":
        return !0;
      case "style":
        if (
          typeof e.precedence != "string" ||
          typeof e.href != "string" ||
          e.href === ""
        )
          break;
        return !0;
      case "link":
        if (
          typeof e.rel != "string" ||
          typeof e.href != "string" ||
          e.href === "" ||
          e.onLoad ||
          e.onError
        )
          break;
        return e.rel === "stylesheet"
          ? ((t = e.disabled), typeof e.precedence == "string" && t == null)
          : !0;
      case "script":
        if (
          e.async &&
          typeof e.async != "function" &&
          typeof e.async != "symbol" &&
          !e.onLoad &&
          !e.onError &&
          e.src &&
          typeof e.src == "string"
        )
          return !0;
    }
    return !1;
  }
  function Im(t) {
    return !(t.type === "stylesheet" && (t.state.loading & 3) === 0);
  }
  var ss = null;
  function F1() {}
  function $1(t, e, n) {
    if (ss === null) throw Error(l(475));
    var s = ss;
    if (
      e.type === "stylesheet" &&
      (typeof n.media != "string" || matchMedia(n.media).matches !== !1) &&
      (e.state.loading & 4) === 0
    ) {
      if (e.instance === null) {
        var o = ea(n.href),
          u = t.querySelector(is(o));
        if (u) {
          (t = u._p),
            t !== null &&
              typeof t == "object" &&
              typeof t.then == "function" &&
              (s.count++, (s = ql.bind(s)), t.then(s, s)),
            (e.state.loading |= 4),
            (e.instance = u),
            Pt(u);
          return;
        }
        (u = t.ownerDocument || t),
          (n = Jm(n)),
          (o = Ve.get(o)) && Yu(n, o),
          (u = u.createElement("link")),
          Pt(u);
        var h = u;
        (h._p = new Promise(function (v, T) {
          (h.onload = v), (h.onerror = T);
        })),
          te(u, "link", n),
          (e.instance = u);
      }
      s.stylesheets === null && (s.stylesheets = new Map()),
        s.stylesheets.set(e, t),
        (t = e.state.preload) &&
          (e.state.loading & 3) === 0 &&
          (s.count++,
          (e = ql.bind(s)),
          t.addEventListener("load", e),
          t.addEventListener("error", e));
    }
  }
  function W1() {
    if (ss === null) throw Error(l(475));
    var t = ss;
    return (
      t.stylesheets && t.count === 0 && Xu(t, t.stylesheets),
      0 < t.count
        ? function (e) {
            var n = setTimeout(function () {
              if ((t.stylesheets && Xu(t, t.stylesheets), t.unsuspend)) {
                var s = t.unsuspend;
                (t.unsuspend = null), s();
              }
            }, 6e4);
            return (
              (t.unsuspend = e),
              function () {
                (t.unsuspend = null), clearTimeout(n);
              }
            );
          }
        : null
    );
  }
  function ql() {
    if ((this.count--, this.count === 0)) {
      if (this.stylesheets) Xu(this, this.stylesheets);
      else if (this.unsuspend) {
        var t = this.unsuspend;
        (this.unsuspend = null), t();
      }
    }
  }
  var Xl = null;
  function Xu(t, e) {
    (t.stylesheets = null),
      t.unsuspend !== null &&
        (t.count++,
        (Xl = new Map()),
        e.forEach(I1, t),
        (Xl = null),
        ql.call(t));
  }
  function I1(t, e) {
    if (!(e.state.loading & 4)) {
      var n = Xl.get(t);
      if (n) var s = n.get(null);
      else {
        (n = new Map()), Xl.set(t, n);
        for (
          var o = t.querySelectorAll(
              "link[data-precedence],style[data-precedence]",
            ),
            u = 0;
          u < o.length;
          u++
        ) {
          var h = o[u];
          (h.nodeName === "LINK" || h.getAttribute("media") !== "not all") &&
            (n.set(h.dataset.precedence, h), (s = h));
        }
        s && n.set(null, s);
      }
      (o = e.instance),
        (h = o.getAttribute("data-precedence")),
        (u = n.get(h) || s),
        u === s && n.set(null, o),
        n.set(h, o),
        this.count++,
        (s = ql.bind(this)),
        o.addEventListener("load", s),
        o.addEventListener("error", s),
        u
          ? u.parentNode.insertBefore(o, u.nextSibling)
          : ((t = t.nodeType === 9 ? t.head : t),
            t.insertBefore(o, t.firstChild)),
        (e.state.loading |= 4);
    }
  }
  var ls = {
    $$typeof: H,
    Provider: null,
    Consumer: null,
    _currentValue: J,
    _currentValue2: J,
    _threadCount: 0,
  };
  function tS(t, e, n, s, o, u, h, v) {
    (this.tag = 1),
      (this.containerInfo = t),
      (this.pingCache = this.current = this.pendingChildren = null),
      (this.timeoutHandle = -1),
      (this.callbackNode =
        this.next =
        this.pendingContext =
        this.context =
        this.cancelPendingCommit =
          null),
      (this.callbackPriority = 0),
      (this.expirationTimes = Br(-1)),
      (this.entangledLanes =
        this.shellSuspendCounter =
        this.errorRecoveryDisabledLanes =
        this.expiredLanes =
        this.warmLanes =
        this.pingedLanes =
        this.suspendedLanes =
        this.pendingLanes =
          0),
      (this.entanglements = Br(0)),
      (this.hiddenUpdates = Br(null)),
      (this.identifierPrefix = s),
      (this.onUncaughtError = o),
      (this.onCaughtError = u),
      (this.onRecoverableError = h),
      (this.pooledCache = null),
      (this.pooledCacheLanes = 0),
      (this.formState = v),
      (this.incompleteTransitions = new Map());
  }
  function tp(t, e, n, s, o, u, h, v, T, C, B, Y) {
    return (
      (t = new tS(t, e, n, h, v, T, C, Y)),
      (e = 1),
      u === !0 && (e |= 24),
      (u = ve(3, null, null, e)),
      (t.current = u),
      (u.stateNode = t),
      (e = Ao()),
      e.refCount++,
      (t.pooledCache = e),
      e.refCount++,
      (u.memoizedState = { element: s, isDehydrated: n, cache: e }),
      Oo(u),
      t
    );
  }
  function ep(t) {
    return t ? ((t = Vi), t) : Vi;
  }
  function np(t, e, n, s, o, u) {
    (o = ep(o)),
      s.context === null ? (s.context = o) : (s.pendingContext = o),
      (s = En(e)),
      (s.payload = { element: n }),
      (u = u === void 0 ? null : u),
      u !== null && (s.callback = u),
      (n = An(t, s, e)),
      n !== null && (Ee(n, t, e), za(n, t, e));
  }
  function ip(t, e) {
    if (((t = t.memoizedState), t !== null && t.dehydrated !== null)) {
      var n = t.retryLane;
      t.retryLane = n !== 0 && n < e ? n : e;
    }
  }
  function ku(t, e) {
    ip(t, e), (t = t.alternate) && ip(t, e);
  }
  function ap(t) {
    if (t.tag === 13) {
      var e = wi(t, 67108864);
      e !== null && Ee(e, t, 67108864), ku(t, 67108864);
    }
  }
  var kl = !0;
  function eS(t, e, n, s) {
    var o = z.T;
    z.T = null;
    var u = Z.p;
    try {
      (Z.p = 2), Zu(t, e, n, s);
    } finally {
      (Z.p = u), (z.T = o);
    }
  }
  function nS(t, e, n, s) {
    var o = z.T;
    z.T = null;
    var u = Z.p;
    try {
      (Z.p = 8), Zu(t, e, n, s);
    } finally {
      (Z.p = u), (z.T = o);
    }
  }
  function Zu(t, e, n, s) {
    if (kl) {
      var o = Ku(s);
      if (o === null) wu(t, e, s, Zl, n), lp(t, s);
      else if (aS(o, t, e, n, s)) s.stopPropagation();
      else if ((lp(t, s), e & 4 && -1 < iS.indexOf(t))) {
        for (; o !== null; ) {
          var u = xi(o);
          if (u !== null)
            switch (u.tag) {
              case 3:
                if (((u = u.stateNode), u.current.memoizedState.isDehydrated)) {
                  var h = Zn(u.pendingLanes);
                  if (h !== 0) {
                    var v = u;
                    for (v.pendingLanes |= 2, v.entangledLanes |= 2; h; ) {
                      var T = 1 << (31 - ye(h));
                      (v.entanglements[1] |= T), (h &= ~T);
                    }
                    Pe(u), (bt & 6) === 0 && ((Ol = qe() + 500), Ia(0));
                  }
                }
                break;
              case 13:
                (v = wi(u, 2)), v !== null && Ee(v, u, 2), jl(), ku(u, 2);
            }
          if (((u = Ku(s)), u === null && wu(t, e, s, Zl, n), u === o)) break;
          o = u;
        }
        o !== null && s.stopPropagation();
      } else wu(t, e, s, null, n);
    }
  }
  function Ku(t) {
    return (t = Fr(t)), Pu(t);
  }
  var Zl = null;
  function Pu(t) {
    if (((Zl = null), (t = Si(t)), t !== null)) {
      var e = d(t);
      if (e === null) t = null;
      else {
        var n = e.tag;
        if (n === 13) {
          if (((t = f(e)), t !== null)) return t;
          t = null;
        } else if (n === 3) {
          if (e.stateNode.current.memoizedState.isDehydrated)
            return e.tag === 3 ? e.stateNode.containerInfo : null;
          t = null;
        } else e !== t && (t = null);
      }
    }
    return (Zl = t), null;
  }
  function sp(t) {
    switch (t) {
      case "beforetoggle":
      case "cancel":
      case "click":
      case "close":
      case "contextmenu":
      case "copy":
      case "cut":
      case "auxclick":
      case "dblclick":
      case "dragend":
      case "dragstart":
      case "drop":
      case "focusin":
      case "focusout":
      case "input":
      case "invalid":
      case "keydown":
      case "keypress":
      case "keyup":
      case "mousedown":
      case "mouseup":
      case "paste":
      case "pause":
      case "play":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
      case "ratechange":
      case "reset":
      case "resize":
      case "seeked":
      case "submit":
      case "toggle":
      case "touchcancel":
      case "touchend":
      case "touchstart":
      case "volumechange":
      case "change":
      case "selectionchange":
      case "textInput":
      case "compositionstart":
      case "compositionend":
      case "compositionupdate":
      case "beforeblur":
      case "afterblur":
      case "beforeinput":
      case "blur":
      case "fullscreenchange":
      case "focus":
      case "hashchange":
      case "popstate":
      case "select":
      case "selectstart":
        return 2;
      case "drag":
      case "dragenter":
      case "dragexit":
      case "dragleave":
      case "dragover":
      case "mousemove":
      case "mouseout":
      case "mouseover":
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "scroll":
      case "touchmove":
      case "wheel":
      case "mouseenter":
      case "mouseleave":
      case "pointerenter":
      case "pointerleave":
        return 8;
      case "message":
        switch (q0()) {
          case Sf:
            return 2;
          case xf:
            return 8;
          case Us:
          case X0:
            return 32;
          case bf:
            return 268435456;
          default:
            return 32;
        }
      default:
        return 32;
    }
  }
  var Qu = !1,
    Un = null,
    Bn = null,
    Hn = null,
    rs = new Map(),
    os = new Map(),
    Gn = [],
    iS =
      "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
        " ",
      );
  function lp(t, e) {
    switch (t) {
      case "focusin":
      case "focusout":
        Un = null;
        break;
      case "dragenter":
      case "dragleave":
        Bn = null;
        break;
      case "mouseover":
      case "mouseout":
        Hn = null;
        break;
      case "pointerover":
      case "pointerout":
        rs.delete(e.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        os.delete(e.pointerId);
    }
  }
  function us(t, e, n, s, o, u) {
    return t === null || t.nativeEvent !== u
      ? ((t = {
          blockedOn: e,
          domEventName: n,
          eventSystemFlags: s,
          nativeEvent: u,
          targetContainers: [o],
        }),
        e !== null && ((e = xi(e)), e !== null && ap(e)),
        t)
      : ((t.eventSystemFlags |= s),
        (e = t.targetContainers),
        o !== null && e.indexOf(o) === -1 && e.push(o),
        t);
  }
  function aS(t, e, n, s, o) {
    switch (e) {
      case "focusin":
        return (Un = us(Un, t, e, n, s, o)), !0;
      case "dragenter":
        return (Bn = us(Bn, t, e, n, s, o)), !0;
      case "mouseover":
        return (Hn = us(Hn, t, e, n, s, o)), !0;
      case "pointerover":
        var u = o.pointerId;
        return rs.set(u, us(rs.get(u) || null, t, e, n, s, o)), !0;
      case "gotpointercapture":
        return (
          (u = o.pointerId), os.set(u, us(os.get(u) || null, t, e, n, s, o)), !0
        );
    }
    return !1;
  }
  function rp(t) {
    var e = Si(t.target);
    if (e !== null) {
      var n = d(e);
      if (n !== null) {
        if (((e = n.tag), e === 13)) {
          if (((e = f(n)), e !== null)) {
            (t.blockedOn = e),
              $0(t.priority, function () {
                if (n.tag === 13) {
                  var s = Te();
                  s = Hr(s);
                  var o = wi(n, s);
                  o !== null && Ee(o, n, s), ku(n, s);
                }
              });
            return;
          }
        } else if (e === 3 && n.stateNode.current.memoizedState.isDehydrated) {
          t.blockedOn = n.tag === 3 ? n.stateNode.containerInfo : null;
          return;
        }
      }
    }
    t.blockedOn = null;
  }
  function Kl(t) {
    if (t.blockedOn !== null) return !1;
    for (var e = t.targetContainers; 0 < e.length; ) {
      var n = Ku(t.nativeEvent);
      if (n === null) {
        n = t.nativeEvent;
        var s = new n.constructor(n.type, n);
        (Jr = s), n.target.dispatchEvent(s), (Jr = null);
      } else return (e = xi(n)), e !== null && ap(e), (t.blockedOn = n), !1;
      e.shift();
    }
    return !0;
  }
  function op(t, e, n) {
    Kl(t) && n.delete(e);
  }
  function sS() {
    (Qu = !1),
      Un !== null && Kl(Un) && (Un = null),
      Bn !== null && Kl(Bn) && (Bn = null),
      Hn !== null && Kl(Hn) && (Hn = null),
      rs.forEach(op),
      os.forEach(op);
  }
  function Pl(t, e) {
    t.blockedOn === e &&
      ((t.blockedOn = null),
      Qu ||
        ((Qu = !0),
        i.unstable_scheduleCallback(i.unstable_NormalPriority, sS)));
  }
  var Ql = null;
  function up(t) {
    Ql !== t &&
      ((Ql = t),
      i.unstable_scheduleCallback(i.unstable_NormalPriority, function () {
        Ql === t && (Ql = null);
        for (var e = 0; e < t.length; e += 3) {
          var n = t[e],
            s = t[e + 1],
            o = t[e + 2];
          if (typeof s != "function") {
            if (Pu(s || n) === null) continue;
            break;
          }
          var u = xi(n);
          u !== null &&
            (t.splice(e, 3),
            (e -= 3),
            Po(u, { pending: !0, data: o, method: n.method, action: s }, s, o));
        }
      }));
  }
  function cs(t) {
    function e(T) {
      return Pl(T, t);
    }
    Un !== null && Pl(Un, t),
      Bn !== null && Pl(Bn, t),
      Hn !== null && Pl(Hn, t),
      rs.forEach(e),
      os.forEach(e);
    for (var n = 0; n < Gn.length; n++) {
      var s = Gn[n];
      s.blockedOn === t && (s.blockedOn = null);
    }
    for (; 0 < Gn.length && ((n = Gn[0]), n.blockedOn === null); )
      rp(n), n.blockedOn === null && Gn.shift();
    if (((n = (t.ownerDocument || t).$$reactFormReplay), n != null))
      for (s = 0; s < n.length; s += 3) {
        var o = n[s],
          u = n[s + 1],
          h = o[ue] || null;
        if (typeof u == "function") h || up(n);
        else if (h) {
          var v = null;
          if (u && u.hasAttribute("formAction")) {
            if (((o = u), (h = u[ue] || null))) v = h.formAction;
            else if (Pu(o) !== null) continue;
          } else v = h.action;
          typeof v == "function" ? (n[s + 1] = v) : (n.splice(s, 3), (s -= 3)),
            up(n);
        }
      }
  }
  function Ju(t) {
    this._internalRoot = t;
  }
  (Jl.prototype.render = Ju.prototype.render =
    function (t) {
      var e = this._internalRoot;
      if (e === null) throw Error(l(409));
      var n = e.current,
        s = Te();
      np(n, s, t, e, null, null);
    }),
    (Jl.prototype.unmount = Ju.prototype.unmount =
      function () {
        var t = this._internalRoot;
        if (t !== null) {
          this._internalRoot = null;
          var e = t.containerInfo;
          np(t.current, 2, null, t, null, null), jl(), (e[vi] = null);
        }
      });
  function Jl(t) {
    this._internalRoot = t;
  }
  Jl.prototype.unstable_scheduleHydration = function (t) {
    if (t) {
      var e = Rf();
      t = { blockedOn: null, target: t, priority: e };
      for (var n = 0; n < Gn.length && e !== 0 && e < Gn[n].priority; n++);
      Gn.splice(n, 0, t), n === 0 && rp(t);
    }
  };
  var cp = a.version;
  if (cp !== "19.1.1") throw Error(l(527, cp, "19.1.1"));
  Z.findDOMNode = function (t) {
    var e = t._reactInternals;
    if (e === void 0)
      throw typeof t.render == "function"
        ? Error(l(188))
        : ((t = Object.keys(t).join(",")), Error(l(268, t)));
    return (
      (t = y(e)),
      (t = t !== null ? p(t) : null),
      (t = t === null ? null : t.stateNode),
      t
    );
  };
  var lS = {
    bundleType: 0,
    version: "19.1.1",
    rendererPackageName: "react-dom",
    currentDispatcherRef: z,
    reconcilerVersion: "19.1.1",
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var Fl = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!Fl.isDisabled && Fl.supportsFiber)
      try {
        (ma = Fl.inject(lS)), (pe = Fl);
      } catch {}
  }
  return (
    (ds.createRoot = function (t, e) {
      if (!c(t)) throw Error(l(299));
      var n = !1,
        s = "",
        o = Rh,
        u = Dh,
        h = Oh,
        v = null;
      return (
        e != null &&
          (e.unstable_strictMode === !0 && (n = !0),
          e.identifierPrefix !== void 0 && (s = e.identifierPrefix),
          e.onUncaughtError !== void 0 && (o = e.onUncaughtError),
          e.onCaughtError !== void 0 && (u = e.onCaughtError),
          e.onRecoverableError !== void 0 && (h = e.onRecoverableError),
          e.unstable_transitionCallbacks !== void 0 &&
            (v = e.unstable_transitionCallbacks)),
        (e = tp(t, 1, !1, null, null, n, s, o, u, h, v, null)),
        (t[vi] = e.current),
        Nu(t),
        new Ju(e)
      );
    }),
    (ds.hydrateRoot = function (t, e, n) {
      if (!c(t)) throw Error(l(299));
      var s = !1,
        o = "",
        u = Rh,
        h = Dh,
        v = Oh,
        T = null,
        C = null;
      return (
        n != null &&
          (n.unstable_strictMode === !0 && (s = !0),
          n.identifierPrefix !== void 0 && (o = n.identifierPrefix),
          n.onUncaughtError !== void 0 && (u = n.onUncaughtError),
          n.onCaughtError !== void 0 && (h = n.onCaughtError),
          n.onRecoverableError !== void 0 && (v = n.onRecoverableError),
          n.unstable_transitionCallbacks !== void 0 &&
            (T = n.unstable_transitionCallbacks),
          n.formState !== void 0 && (C = n.formState)),
        (e = tp(t, 1, !0, e, n ?? null, s, o, u, h, v, T, C)),
        (e.context = ep(null)),
        (n = e.current),
        (s = Te()),
        (s = Hr(s)),
        (o = En(s)),
        (o.callback = null),
        An(n, o, s),
        (n = s),
        (e.current.lanes = n),
        ya(e, n),
        Pe(e),
        (t[vi] = e.current),
        Nu(t),
        new Jl(e)
      );
    }),
    (ds.version = "19.1.1"),
    ds
  );
}
var xp;
function yS() {
  if (xp) return Wu.exports;
  xp = 1;
  function i() {
    if (
      !(
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" ||
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"
      )
    )
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(i);
      } catch (a) {
        console.error(a);
      }
  }
  return i(), (Wu.exports = pS()), Wu.exports;
}
var gS = yS();
const Ss = U.createContext({});
function Er(i) {
  const a = U.useRef(null);
  return a.current === null && (a.current = i()), a.current;
}
const vS = typeof window < "u",
  Ar = vS ? U.useLayoutEffect : U.useEffect,
  Mr = U.createContext(null);
function Kc(i, a) {
  i.indexOf(a) === -1 && i.push(a);
}
function dr(i, a) {
  const r = i.indexOf(a);
  r > -1 && i.splice(r, 1);
}
const $e = (i, a, r) => (r > a ? a : r < i ? i : r);
let Rr = () => {};
const Xn = {},
  Zy = (i) => /^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(i),
  Ky = (i) => typeof i == "object" && i !== null,
  Py = (i) => /^0[^.\s]+$/u.test(i);
function Qy(i) {
  let a;
  return () => (a === void 0 && (a = i()), a);
}
const Le = (i) => i,
  Ms = (...i) => i.reduce((a, r) => (l) => r(a(l))),
  xs = (i, a, r) => {
    const l = a - i;
    return l ? (r - i) / l : 1;
  };
class Pc {
  constructor() {
    this.subscriptions = [];
  }
  add(a) {
    return Kc(this.subscriptions, a), () => dr(this.subscriptions, a);
  }
  notify(a, r, l) {
    const c = this.subscriptions.length;
    if (c)
      if (c === 1) this.subscriptions[0](a, r, l);
      else
        for (let d = 0; d < c; d++) {
          const f = this.subscriptions[d];
          f && f(a, r, l);
        }
  }
  getSize() {
    return this.subscriptions.length;
  }
  clear() {
    this.subscriptions.length = 0;
  }
}
const Ae = (i) => i * 1e3,
  _e = (i) => i / 1e3,
  Jy = (i, a) => (a ? i * (1e3 / a) : 0),
  Fy = (i, a, r) =>
    (((1 - 3 * r + 3 * a) * i + (3 * r - 6 * a)) * i + 3 * a) * i,
  SS = 1e-7,
  xS = 12;
function bS(i, a, r, l, c) {
  let d,
    f,
    m = 0;
  do (f = a + (r - a) / 2), (d = Fy(f, l, c) - i), d > 0 ? (r = f) : (a = f);
  while (Math.abs(d) > SS && ++m < xS);
  return f;
}
function Rs(i, a, r, l) {
  if (i === a && r === l) return Le;
  const c = (d) => bS(d, 0, 1, i, r);
  return (d) => (d === 0 || d === 1 ? d : Fy(c(d), a, l));
}
const $y = (i) => (a) => (a <= 0.5 ? i(2 * a) / 2 : (2 - i(2 * (1 - a))) / 2),
  Wy = (i) => (a) => 1 - i(1 - a),
  Iy = Rs(0.33, 1.53, 0.69, 0.99),
  Qc = Wy(Iy),
  tg = $y(Qc),
  eg = (i) =>
    i >= 1
      ? 1
      : (i *= 2) < 1
        ? 0.5 * Qc(i)
        : 0.5 * (2 - Math.pow(2, -10 * (i - 1))),
  Jc = (i) => 1 - Math.sin(Math.acos(i)),
  ng = Wy(Jc),
  ig = $y(Jc),
  TS = Rs(0.42, 0, 1, 1),
  ES = Rs(0, 0, 0.58, 1),
  ag = Rs(0.42, 0, 0.58, 1),
  AS = (i) => Array.isArray(i) && typeof i[0] != "number",
  sg = (i) => Array.isArray(i) && typeof i[0] == "number",
  MS = {
    linear: Le,
    easeIn: TS,
    easeInOut: ag,
    easeOut: ES,
    circIn: Jc,
    circInOut: ig,
    circOut: ng,
    backIn: Qc,
    backInOut: tg,
    backOut: Iy,
    anticipate: eg,
  },
  RS = (i) => typeof i == "string",
  bp = (i) => {
    if (sg(i)) {
      Rr(i.length === 4);
      const [a, r, l, c] = i;
      return Rs(a, r, l, c);
    } else if (RS(i)) return MS[i];
    return i;
  },
  $l = [
    "setup",
    "read",
    "resolveKeyframes",
    "preUpdate",
    "update",
    "preRender",
    "render",
    "postRender",
  ];
function DS(i) {
  let a = new Set(),
    r = new Set(),
    l = !1,
    c = !1;
  const d = new WeakSet();
  let f = { delta: 0, timestamp: 0, isProcessing: !1 };
  function m(p) {
    d.has(p) && (y.schedule(p), i()), p(f);
  }
  const y = {
    schedule: (p, g = !1, x = !1) => {
      const j = x && l ? a : r;
      return g && d.add(p), j.add(p), p;
    },
    cancel: (p) => {
      r.delete(p), d.delete(p);
    },
    process: (p) => {
      if (((f = p), l)) {
        c = !0;
        return;
      }
      l = !0;
      const g = a;
      (a = r),
        (r = g),
        a.forEach(m),
        a.clear(),
        (l = !1),
        c && ((c = !1), y.process(p));
    },
  };
  return y;
}
const OS = 40;
function lg(i, a) {
  let r = !1,
    l = !0;
  const c = { delta: 0, timestamp: 0, isProcessing: !1 },
    d = () => (r = !0),
    f = $l.reduce((H, X) => ((H[X] = DS(d)), H), {}),
    {
      setup: m,
      read: y,
      resolveKeyframes: p,
      preUpdate: g,
      update: x,
      preRender: b,
      render: j,
      postRender: A,
    } = f,
    R = () => {
      const H = Xn.useManualTiming,
        X = H ? c.timestamp : performance.now();
      (r = !1),
        H ||
          (c.delta = l ? 1e3 / 60 : Math.max(Math.min(X - c.timestamp, OS), 1)),
        (c.timestamp = X),
        (c.isProcessing = !0),
        m.process(c),
        y.process(c),
        p.process(c),
        g.process(c),
        x.process(c),
        b.process(c),
        j.process(c),
        A.process(c),
        (c.isProcessing = !1),
        r && a && ((l = !1), i(R));
    },
    V = () => {
      (r = !0), (l = !0), c.isProcessing || i(R);
    };
  return {
    schedule: $l.reduce((H, X) => {
      const k = f[X];
      return (
        (H[X] = (tt, et = !1, P = !1) => (r || V(), k.schedule(tt, et, P))), H
      );
    }, {}),
    cancel: (H) => {
      for (let X = 0; X < $l.length; X++) f[$l[X]].cancel(H);
    },
    state: c,
    steps: f,
  };
}
const {
  schedule: Et,
  cancel: pn,
  state: ee,
  steps: nc,
} = lg(typeof requestAnimationFrame < "u" ? requestAnimationFrame : Le, !0);
let ir;
function CS() {
  ir = void 0;
}
const re = {
    now: () => (
      ir === void 0 &&
        re.set(
          ee.isProcessing || Xn.useManualTiming
            ? ee.timestamp
            : performance.now(),
        ),
      ir
    ),
    set: (i) => {
      (ir = i), queueMicrotask(CS);
    },
  },
  rg = (i) => (a) => typeof a == "string" && a.startsWith(i),
  og = rg("--"),
  jS = rg("var(--"),
  Fc = (i) => (jS(i) ? NS.test(i.split("/*")[0].trim()) : !1),
  NS =
    /var\(--(?:[\w-]+\s*|[\w-]+\s*,(?:\s*[^)(\s]|\s*\((?:[^)(]|\([^)(]*\))*\))+\s*)\)$/iu;
function Tp(i) {
  return typeof i != "string" ? !1 : i.split("/*")[0].includes("var(--");
}
const oa = {
    test: (i) => typeof i == "number",
    parse: parseFloat,
    transform: (i) => i,
  },
  bs = { ...oa, transform: (i) => $e(0, 1, i) },
  Wl = { ...oa, default: 1 },
  ps = (i) => Math.round(i * 1e5) / 1e5,
  $c = /-?(?:\d+(?:\.\d+)?|\.\d+)/gu;
function wS(i) {
  return i == null;
}
const VS =
    /^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\))$/iu,
  Wc = (i, a) => (r) =>
    !!(
      (typeof r == "string" && VS.test(r) && r.startsWith(i)) ||
      (a && !wS(r) && Object.prototype.hasOwnProperty.call(r, a))
    ),
  ug = (i, a, r) => (l) => {
    if (typeof l != "string") return l;
    const [c, d, f, m] = l.match($c);
    return {
      [i]: parseFloat(c),
      [a]: parseFloat(d),
      [r]: parseFloat(f),
      alpha: m !== void 0 ? parseFloat(m) : 1,
    };
  },
  _S = (i) => $e(0, 255, i),
  ic = { ...oa, transform: (i) => Math.round(_S(i)) },
  di = {
    test: Wc("rgb", "red"),
    parse: ug("red", "green", "blue"),
    transform: ({ red: i, green: a, blue: r, alpha: l = 1 }) =>
      "rgba(" +
      ic.transform(i) +
      ", " +
      ic.transform(a) +
      ", " +
      ic.transform(r) +
      ", " +
      ps(bs.transform(l)) +
      ")",
  };
function LS(i) {
  let a = "",
    r = "",
    l = "",
    c = "";
  return (
    i.length > 5
      ? ((a = i.substring(1, 3)),
        (r = i.substring(3, 5)),
        (l = i.substring(5, 7)),
        (c = i.substring(7, 9)))
      : ((a = i.substring(1, 2)),
        (r = i.substring(2, 3)),
        (l = i.substring(3, 4)),
        (c = i.substring(4, 5)),
        (a += a),
        (r += r),
        (l += l),
        (c += c)),
    {
      red: parseInt(a, 16),
      green: parseInt(r, 16),
      blue: parseInt(l, 16),
      alpha: c ? parseInt(c, 16) / 255 : 1,
    }
  );
}
const vc = { test: Wc("#"), parse: LS, transform: di.transform },
  Ds = (i) => ({
    test: (a) =>
      typeof a == "string" && a.endsWith(i) && a.split(" ").length === 1,
    parse: parseFloat,
    transform: (a) => `${a}${i}`,
  }),
  mn = Ds("deg"),
  Fe = Ds("%"),
  $ = Ds("px"),
  zS = Ds("vh"),
  US = Ds("vw"),
  Ep = {
    ...Fe,
    parse: (i) => Fe.parse(i) / 100,
    transform: (i) => Fe.transform(i * 100),
  },
  aa = {
    test: Wc("hsl", "hue"),
    parse: ug("hue", "saturation", "lightness"),
    transform: ({ hue: i, saturation: a, lightness: r, alpha: l = 1 }) =>
      "hsla(" +
      Math.round(i) +
      ", " +
      Fe.transform(ps(a)) +
      ", " +
      Fe.transform(ps(r)) +
      ", " +
      ps(bs.transform(l)) +
      ")",
  },
  qt = {
    test: (i) => di.test(i) || vc.test(i) || aa.test(i),
    parse: (i) =>
      di.test(i) ? di.parse(i) : aa.test(i) ? aa.parse(i) : vc.parse(i),
    transform: (i) =>
      typeof i == "string"
        ? i
        : i.hasOwnProperty("red")
          ? di.transform(i)
          : aa.transform(i),
    getAnimatableNone: (i) => {
      const a = qt.parse(i);
      return (a.alpha = 0), qt.transform(a);
    },
  },
  BS =
    /(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\))/giu;
function HS(i) {
  return (
    isNaN(i) &&
    typeof i == "string" &&
    (i.match($c)?.length || 0) + (i.match(BS)?.length || 0) > 0
  );
}
const cg = "number",
  fg = "color",
  GS = "var",
  YS = "var(",
  Ap = "${}",
  qS =
    /var\s*\(\s*--(?:[\w-]+\s*|[\w-]+\s*,(?:\s*[^)(\s]|\s*\((?:[^)(]|\([^)(]*\))*\))+\s*)\)|#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\)|-?(?:\d+(?:\.\d+)?|\.\d+)/giu;
function ra(i) {
  const a = i.toString(),
    r = [],
    l = { color: [], number: [], var: [] },
    c = [];
  let d = 0;
  const m = a
    .replace(
      qS,
      (y) => (
        qt.test(y)
          ? (l.color.push(d), c.push(fg), r.push(qt.parse(y)))
          : y.startsWith(YS)
            ? (l.var.push(d), c.push(GS), r.push(y))
            : (l.number.push(d), c.push(cg), r.push(parseFloat(y))),
        ++d,
        Ap
      ),
    )
    .split(Ap);
  return { values: r, split: m, indexes: l, types: c };
}
function XS(i) {
  return ra(i).values;
}
function dg({ split: i, types: a }) {
  const r = i.length;
  return (l) => {
    let c = "";
    for (let d = 0; d < r; d++)
      if (((c += i[d]), l[d] !== void 0)) {
        const f = a[d];
        f === cg
          ? (c += ps(l[d]))
          : f === fg
            ? (c += qt.transform(l[d]))
            : (c += l[d]);
      }
    return c;
  };
}
function kS(i) {
  return dg(ra(i));
}
const ZS = (i) =>
    typeof i == "number" ? 0 : qt.test(i) ? qt.getAnimatableNone(i) : i,
  KS = (i, a) =>
    typeof i == "number" ? (a?.trim().endsWith("/") ? i : 0) : ZS(i);
function PS(i) {
  const a = ra(i);
  return dg(a)(a.values.map((l, c) => KS(l, a.split[c])));
}
const Ye = {
  test: HS,
  parse: XS,
  createTransformer: kS,
  getAnimatableNone: PS,
};
function ac(i, a, r) {
  return (
    r < 0 && (r += 1),
    r > 1 && (r -= 1),
    r < 1 / 6
      ? i + (a - i) * 6 * r
      : r < 1 / 2
        ? a
        : r < 2 / 3
          ? i + (a - i) * (2 / 3 - r) * 6
          : i
  );
}
function QS({ hue: i, saturation: a, lightness: r, alpha: l }) {
  (i /= 360), (a /= 100), (r /= 100);
  let c = 0,
    d = 0,
    f = 0;
  if (!a) c = d = f = r;
  else {
    const m = r < 0.5 ? r * (1 + a) : r + a - r * a,
      y = 2 * r - m;
    (c = ac(y, m, i + 1 / 3)), (d = ac(y, m, i)), (f = ac(y, m, i - 1 / 3));
  }
  return {
    red: Math.round(c * 255),
    green: Math.round(d * 255),
    blue: Math.round(f * 255),
    alpha: l,
  };
}
function hr(i, a) {
  return (r) => (r > 0 ? a : i);
}
const Ot = (i, a, r) => i + (a - i) * r,
  sc = (i, a, r) => {
    const l = i * i,
      c = r * (a * a - l) + l;
    return c < 0 ? 0 : Math.sqrt(c);
  },
  JS = [vc, di, aa],
  FS = (i) => JS.find((a) => a.test(i));
function Mp(i) {
  const a = FS(i);
  if (!a) return !1;
  let r = a.parse(i);
  return a === aa && (r = QS(r)), r;
}
const Rp = (i, a) => {
    const r = Mp(i),
      l = Mp(a);
    if (!r || !l) return hr(i, a);
    const c = { ...r };
    return (d) => (
      (c.red = sc(r.red, l.red, d)),
      (c.green = sc(r.green, l.green, d)),
      (c.blue = sc(r.blue, l.blue, d)),
      (c.alpha = Ot(r.alpha, l.alpha, d)),
      di.transform(c)
    );
  },
  Sc = new Set(["none", "hidden"]);
function $S(i, a) {
  return Sc.has(i) ? (r) => (r <= 0 ? i : a) : (r) => (r >= 1 ? a : i);
}
function WS(i, a) {
  return (r) => Ot(i, a, r);
}
function Ic(i) {
  return typeof i == "number"
    ? WS
    : typeof i == "string"
      ? Fc(i)
        ? hr
        : qt.test(i)
          ? Rp
          : ex
      : Array.isArray(i)
        ? hg
        : typeof i == "object"
          ? qt.test(i)
            ? Rp
            : IS
          : hr;
}
function hg(i, a) {
  const r = [...i],
    l = r.length,
    c = i.map((d, f) => Ic(d)(d, a[f]));
  return (d) => {
    for (let f = 0; f < l; f++) r[f] = c[f](d);
    return r;
  };
}
function IS(i, a) {
  const r = { ...i, ...a },
    l = {};
  for (const c in r)
    i[c] !== void 0 && a[c] !== void 0 && (l[c] = Ic(i[c])(i[c], a[c]));
  return (c) => {
    for (const d in l) r[d] = l[d](c);
    return r;
  };
}
function tx(i, a) {
  const r = [],
    l = { color: 0, var: 0, number: 0 };
  for (let c = 0; c < a.values.length; c++) {
    const d = a.types[c],
      f = i.indexes[d][l[d]],
      m = i.values[f] ?? 0;
    (r[c] = m), l[d]++;
  }
  return r;
}
const ex = (i, a) => {
  const r = Ye.createTransformer(a),
    l = ra(i),
    c = ra(a);
  return l.indexes.var.length === c.indexes.var.length &&
    l.indexes.color.length === c.indexes.color.length &&
    l.indexes.number.length >= c.indexes.number.length
    ? (Sc.has(i) && !c.values.length) || (Sc.has(a) && !l.values.length)
      ? $S(i, a)
      : Ms(hg(tx(l, c), c.values), r)
    : hr(i, a);
};
function mg(i, a, r) {
  return typeof i == "number" && typeof a == "number" && typeof r == "number"
    ? Ot(i, a, r)
    : Ic(i)(i, a);
}
const nx = (i) => {
    const a = ({ timestamp: r }) => i(r);
    return {
      start: (r = !0) => Et.update(a, r),
      stop: () => pn(a),
      now: () => (ee.isProcessing ? ee.timestamp : re.now()),
    };
  },
  pg = (i, a, r = 10) => {
    let l = "";
    const c = Math.max(Math.round(a / r), 2);
    for (let d = 0; d < c; d++)
      l += Math.round(i(d / (c - 1)) * 1e4) / 1e4 + ", ";
    return `linear(${l.substring(0, l.length - 2)})`;
  },
  mr = 2e4;
function tf(i) {
  let a = 0;
  const r = 50;
  let l = i.next(a);
  for (; !l.done && a < mr; ) (a += r), (l = i.next(a));
  return a >= mr ? 1 / 0 : a;
}
function ix(i, a = 100, r) {
  const l = r({ ...i, keyframes: [0, a] }),
    c = Math.min(tf(l), mr);
  return {
    type: "keyframes",
    ease: (d) => l.next(c * d).value / a,
    duration: _e(c),
  };
}
const Ut = {
  stiffness: 100,
  damping: 10,
  mass: 1,
  velocity: 0,
  duration: 800,
  bounce: 0.3,
  visualDuration: 0.3,
  restSpeed: { granular: 0.01, default: 2 },
  restDelta: { granular: 0.005, default: 0.5 },
  minDuration: 0.01,
  maxDuration: 10,
  minDamping: 0.05,
  maxDamping: 1,
};
function xc(i, a) {
  return i * Math.sqrt(1 - a * a);
}
const ax = 12;
function sx(i, a, r) {
  let l = r;
  for (let c = 1; c < ax; c++) l = l - i(l) / a(l);
  return l;
}
const lc = 0.001;
function lx({
  duration: i = Ut.duration,
  bounce: a = Ut.bounce,
  velocity: r = Ut.velocity,
  mass: l = Ut.mass,
}) {
  let c,
    d,
    f = 1 - a;
  (f = $e(Ut.minDamping, Ut.maxDamping, f)),
    (i = $e(Ut.minDuration, Ut.maxDuration, _e(i))),
    f < 1
      ? ((c = (p) => {
          const g = p * f,
            x = g * i,
            b = g - r,
            j = xc(p, f),
            A = Math.exp(-x);
          return lc - (b / j) * A;
        }),
        (d = (p) => {
          const x = p * f * i,
            b = x * r + r,
            j = Math.pow(f, 2) * Math.pow(p, 2) * i,
            A = Math.exp(-x),
            R = xc(Math.pow(p, 2), f);
          return ((-c(p) + lc > 0 ? -1 : 1) * ((b - j) * A)) / R;
        }))
      : ((c = (p) => {
          const g = Math.exp(-p * i),
            x = (p - r) * i + 1;
          return -lc + g * x;
        }),
        (d = (p) => {
          const g = Math.exp(-p * i),
            x = (r - p) * (i * i);
          return g * x;
        }));
  const m = 5 / i,
    y = sx(c, d, m);
  if (((i = Ae(i)), isNaN(y)))
    return { stiffness: Ut.stiffness, damping: Ut.damping, duration: i };
  {
    const p = Math.pow(y, 2) * l;
    return { stiffness: p, damping: f * 2 * Math.sqrt(l * p), duration: i };
  }
}
const rx = ["duration", "bounce"],
  ox = ["stiffness", "damping", "mass"];
function Dp(i, a) {
  return a.some((r) => i[r] !== void 0);
}
function ux(i) {
  let a = {
    velocity: Ut.velocity,
    stiffness: Ut.stiffness,
    damping: Ut.damping,
    mass: Ut.mass,
    isResolvedFromDuration: !1,
    ...i,
  };
  if (!Dp(i, ox) && Dp(i, rx))
    if (((a.velocity = 0), i.visualDuration)) {
      const r = i.visualDuration,
        l = (2 * Math.PI) / (r * 1.2),
        c = l * l,
        d = 2 * $e(0.05, 1, 1 - (i.bounce || 0)) * Math.sqrt(c);
      a = { ...a, mass: Ut.mass, stiffness: c, damping: d };
    } else {
      const r = lx({ ...i, velocity: 0 });
      (a = { ...a, ...r, mass: Ut.mass }), (a.isResolvedFromDuration = !0);
    }
  return a;
}
function pr(i = Ut.visualDuration, a = Ut.bounce) {
  const r =
    typeof i != "object"
      ? { visualDuration: i, keyframes: [0, 1], bounce: a }
      : i;
  let { restSpeed: l, restDelta: c } = r;
  const d = r.keyframes[0],
    f = r.keyframes[r.keyframes.length - 1],
    m = { done: !1, value: d },
    {
      stiffness: y,
      damping: p,
      mass: g,
      duration: x,
      velocity: b,
      isResolvedFromDuration: j,
    } = ux({ ...r, velocity: -_e(r.velocity || 0) }),
    A = b || 0,
    R = p / (2 * Math.sqrt(y * g)),
    V = f - d,
    L = _e(Math.sqrt(y / g)),
    _ = Math.abs(V) < 5;
  l || (l = _ ? Ut.restSpeed.granular : Ut.restSpeed.default),
    c || (c = _ ? Ut.restDelta.granular : Ut.restDelta.default);
  let H, X, k, tt, et, P;
  if (R < 1)
    (k = xc(L, R)),
      (tt = (A + R * L * V) / k),
      (H = (W) => {
        const mt = Math.exp(-R * L * W);
        return f - mt * (tt * Math.sin(k * W) + V * Math.cos(k * W));
      }),
      (et = R * L * tt + V * k),
      (P = R * L * V - tt * k),
      (X = (W) =>
        Math.exp(-R * L * W) * (et * Math.sin(k * W) + P * Math.cos(k * W)));
  else if (R === 1) {
    H = (mt) => f - Math.exp(-L * mt) * (V + (A + L * V) * mt);
    const W = A + L * V;
    X = (mt) => Math.exp(-L * mt) * (L * W * mt - A);
  } else {
    const W = L * Math.sqrt(R * R - 1);
    H = (Kt) => {
      const Ct = Math.exp(-R * L * Kt),
        z = Math.min(W * Kt, 300);
      return (
        f - (Ct * ((A + R * L * V) * Math.sinh(z) + W * V * Math.cosh(z))) / W
      );
    };
    const mt = (A + R * L * V) / W,
      pt = R * L * mt - V * W,
      $t = R * L * V - mt * W;
    X = (Kt) => {
      const Ct = Math.exp(-R * L * Kt),
        z = Math.min(W * Kt, 300);
      return Ct * (pt * Math.sinh(z) + $t * Math.cosh(z));
    };
  }
  const lt = {
    calculatedDuration: (j && x) || null,
    velocity: (W) => Ae(X(W)),
    next: (W) => {
      if (!j && R < 1) {
        const pt = Math.exp(-R * L * W),
          $t = Math.sin(k * W),
          Kt = Math.cos(k * W),
          Ct = f - pt * (tt * $t + V * Kt),
          z = Ae(pt * (et * $t + P * Kt));
        return (
          (m.done = Math.abs(z) <= l && Math.abs(f - Ct) <= c),
          (m.value = m.done ? f : Ct),
          m
        );
      }
      const mt = H(W);
      if (j) m.done = W >= x;
      else {
        const pt = Ae(X(W));
        m.done = Math.abs(pt) <= l && Math.abs(f - mt) <= c;
      }
      return (m.value = m.done ? f : mt), m;
    },
    toString: () => {
      const W = Math.min(tf(lt), mr),
        mt = pg((pt) => lt.next(W * pt).value, W, 30);
      return W + "ms " + mt;
    },
    toTransition: () => {},
  };
  return lt;
}
pr.applyToOptions = (i) => {
  const a = ix(i, 100, pr);
  return (
    (i.ease = a.ease), (i.duration = Ae(a.duration)), (i.type = "keyframes"), i
  );
};
const cx = 5;
function yg(i, a, r) {
  const l = Math.max(a - cx, 0);
  return Jy(r - i(l), a - l);
}
function bc({
  keyframes: i,
  velocity: a = 0,
  power: r = 0.8,
  timeConstant: l = 325,
  bounceDamping: c = 10,
  bounceStiffness: d = 500,
  modifyTarget: f,
  min: m,
  max: y,
  restDelta: p = 0.5,
  restSpeed: g,
}) {
  const x = i[0],
    b = { done: !1, value: x },
    j = (P) => (m !== void 0 && P < m) || (y !== void 0 && P > y),
    A = (P) =>
      m === void 0
        ? y
        : y === void 0 || Math.abs(m - P) < Math.abs(y - P)
          ? m
          : y;
  let R = r * a;
  const V = x + R,
    L = f === void 0 ? V : f(V);
  L !== V && (R = L - x);
  const _ = (P) => -R * Math.exp(-P / l),
    H = (P) => L + _(P),
    X = (P) => {
      const lt = _(P),
        W = H(P);
      (b.done = Math.abs(lt) <= p), (b.value = b.done ? L : W);
    };
  let k, tt;
  const et = (P) => {
    j(b.value) &&
      ((k = P),
      (tt = pr({
        keyframes: [b.value, A(b.value)],
        velocity: yg(H, P, b.value),
        damping: c,
        stiffness: d,
        restDelta: p,
        restSpeed: g,
      })));
  };
  return (
    et(0),
    {
      calculatedDuration: null,
      next: (P) => {
        let lt = !1;
        return (
          !tt && k === void 0 && ((lt = !0), X(P), et(P)),
          k !== void 0 && P >= k ? tt.next(P - k) : (!lt && X(P), b)
        );
      },
    }
  );
}
function fx(i, a, r) {
  const l = [],
    c = r || Xn.mix || mg,
    d = i.length - 1;
  for (let f = 0; f < d; f++) {
    let m = c(i[f], i[f + 1]);
    if (a) {
      const y = Array.isArray(a) ? a[f] || Le : a;
      m = Ms(y, m);
    }
    l.push(m);
  }
  return l;
}
function dx(i, a, { clamp: r = !0, ease: l, mixer: c } = {}) {
  const d = i.length;
  if ((Rr(d === a.length), d === 1)) return () => a[0];
  if (d === 2 && a[0] === a[1]) return () => a[1];
  const f = i[0] === i[1];
  i[0] > i[d - 1] && ((i = [...i].reverse()), (a = [...a].reverse()));
  const m = fx(a, l, c),
    y = m.length,
    p = (g) => {
      if (f && g < i[0]) return a[0];
      let x = 0;
      if (y > 1) for (; x < i.length - 2 && !(g < i[x + 1]); x++);
      const b = xs(i[x], i[x + 1], g);
      return m[x](b);
    };
  return r ? (g) => p($e(i[0], i[d - 1], g)) : p;
}
function hx(i, a) {
  const r = i[i.length - 1];
  for (let l = 1; l <= a; l++) {
    const c = xs(0, a, l);
    i.push(Ot(r, 1, c));
  }
}
function mx(i) {
  const a = [0];
  return hx(a, i.length - 1), a;
}
function px(i, a) {
  return i.map((r) => r * a);
}
function yx(i, a) {
  return i.map(() => a || ag).splice(0, i.length - 1);
}
function ys({
  duration: i = 300,
  keyframes: a,
  times: r,
  ease: l = "easeInOut",
}) {
  const c = AS(l) ? l.map(bp) : bp(l),
    d = { done: !1, value: a[0] },
    f = px(r && r.length === a.length ? r : mx(a), i),
    m = dx(f, a, { ease: Array.isArray(c) ? c : yx(a, c) });
  return {
    calculatedDuration: i,
    next: (y) => ((d.value = m(y)), (d.done = y >= i), d),
  };
}
const gx = (i) => i !== null;
function Dr(i, { repeat: a, repeatType: r = "loop" }, l, c = 1) {
  const d = i.filter(gx),
    m = c < 0 || (a && r !== "loop" && a % 2 === 1) ? 0 : d.length - 1;
  return !m || l === void 0 ? d[m] : l;
}
const vx = { decay: bc, inertia: bc, tween: ys, keyframes: ys, spring: pr };
function gg(i) {
  typeof i.type == "string" && (i.type = vx[i.type]);
}
class ef {
  constructor() {
    this.updateFinished();
  }
  get finished() {
    return this._finished;
  }
  updateFinished() {
    this._finished = new Promise((a) => {
      this.resolve = a;
    });
  }
  notifyFinished() {
    this.resolve();
  }
  then(a, r) {
    return this.finished.then(a, r);
  }
}
const Sx = (i) => i / 100;
class yr extends ef {
  constructor(a) {
    super(),
      (this.state = "idle"),
      (this.startTime = null),
      (this.isStopped = !1),
      (this.currentTime = 0),
      (this.holdTime = null),
      (this.playbackSpeed = 1),
      (this.delayState = { done: !1, value: void 0 }),
      (this.stop = () => {
        const { motionValue: r } = this.options;
        r && r.updatedAt !== re.now() && this.tick(re.now()),
          (this.isStopped = !0),
          this.state !== "idle" && (this.teardown(), this.options.onStop?.());
      }),
      (this.options = a),
      this.initAnimation(),
      this.play(),
      a.autoplay === !1 && this.pause();
  }
  initAnimation() {
    const { options: a } = this;
    gg(a);
    const {
      type: r = ys,
      repeat: l = 0,
      repeatDelay: c = 0,
      repeatType: d,
      velocity: f = 0,
    } = a;
    let { keyframes: m } = a;
    const y = r || ys;
    y !== ys &&
      typeof m[0] != "number" &&
      ((this.mixKeyframes = Ms(Sx, mg(m[0], m[1]))), (m = [0, 100]));
    const p = y({ ...a, keyframes: m });
    d === "mirror" &&
      (this.mirroredGenerator = y({
        ...a,
        keyframes: [...m].reverse(),
        velocity: -f,
      })),
      p.calculatedDuration === null && (p.calculatedDuration = tf(p));
    const { calculatedDuration: g } = p;
    (this.calculatedDuration = g),
      (this.resolvedDuration = g + c),
      (this.totalDuration = this.resolvedDuration * (l + 1) - c),
      (this.generator = p);
  }
  updateTime(a) {
    const r = Math.round(a - this.startTime) * this.playbackSpeed;
    this.holdTime !== null
      ? (this.currentTime = this.holdTime)
      : (this.currentTime = r);
  }
  tick(a, r = !1) {
    const {
      generator: l,
      totalDuration: c,
      mixKeyframes: d,
      mirroredGenerator: f,
      resolvedDuration: m,
      calculatedDuration: y,
    } = this;
    if (this.startTime === null) return l.next(0);
    const {
      delay: p = 0,
      keyframes: g,
      repeat: x,
      repeatType: b,
      repeatDelay: j,
      type: A,
      onUpdate: R,
      finalKeyframe: V,
    } = this.options;
    this.speed > 0
      ? (this.startTime = Math.min(this.startTime, a))
      : this.speed < 0 &&
        (this.startTime = Math.min(a - c / this.speed, this.startTime)),
      r ? (this.currentTime = a) : this.updateTime(a);
    const L = this.currentTime - p * (this.playbackSpeed >= 0 ? 1 : -1),
      _ = this.playbackSpeed >= 0 ? L < 0 : L > c;
    (this.currentTime = Math.max(L, 0)),
      this.state === "finished" &&
        this.holdTime === null &&
        (this.currentTime = c);
    let H = this.currentTime,
      X = l;
    if (x) {
      const P = Math.min(this.currentTime, c) / m;
      let lt = Math.floor(P),
        W = P % 1;
      !W && P >= 1 && (W = 1),
        W === 1 && lt--,
        (lt = Math.min(lt, x + 1)),
        lt % 2 &&
          (b === "reverse"
            ? ((W = 1 - W), j && (W -= j / m))
            : b === "mirror" && (X = f)),
        (H = $e(0, 1, W) * m);
    }
    let k;
    _
      ? ((this.delayState.value = g[0]), (k = this.delayState))
      : (k = X.next(H)),
      d && !_ && (k.value = d(k.value));
    let { done: tt } = k;
    !_ &&
      y !== null &&
      (tt =
        this.playbackSpeed >= 0
          ? this.currentTime >= c
          : this.currentTime <= 0);
    const et =
      this.holdTime === null &&
      (this.state === "finished" || (this.state === "running" && tt));
    return (
      et && A !== bc && (k.value = Dr(g, this.options, V, this.speed)),
      R && R(k.value),
      et && this.finish(),
      k
    );
  }
  then(a, r) {
    return this.finished.then(a, r);
  }
  get duration() {
    return _e(this.calculatedDuration);
  }
  get iterationDuration() {
    const { delay: a = 0 } = this.options || {};
    return this.duration + _e(a);
  }
  get time() {
    return _e(this.currentTime);
  }
  set time(a) {
    (a = Ae(a)),
      (this.currentTime = a),
      this.startTime === null ||
      this.holdTime !== null ||
      this.playbackSpeed === 0
        ? (this.holdTime = a)
        : this.driver &&
          (this.startTime = this.driver.now() - a / this.playbackSpeed),
      this.driver
        ? this.driver.start(!1)
        : ((this.startTime = 0),
          (this.state = "paused"),
          (this.holdTime = a),
          this.tick(a));
  }
  getGeneratorVelocity() {
    const a = this.currentTime;
    if (a <= 0) return this.options.velocity || 0;
    if (this.generator.velocity) return this.generator.velocity(a);
    const r = this.generator.next(a).value;
    return yg((l) => this.generator.next(l).value, a, r);
  }
  get speed() {
    return this.playbackSpeed;
  }
  set speed(a) {
    const r = this.playbackSpeed !== a;
    r && this.driver && this.updateTime(re.now()),
      (this.playbackSpeed = a),
      r && this.driver && (this.time = _e(this.currentTime));
  }
  play() {
    if (this.isStopped) return;
    const { driver: a = nx, startTime: r } = this.options;
    this.driver || (this.driver = a((c) => this.tick(c))),
      this.options.onPlay?.();
    const l = this.driver.now();
    this.state === "finished"
      ? (this.updateFinished(), (this.startTime = l))
      : this.holdTime !== null
        ? (this.startTime = l - this.holdTime)
        : this.startTime || (this.startTime = r ?? l),
      this.state === "finished" &&
        this.speed < 0 &&
        (this.startTime += this.calculatedDuration),
      (this.holdTime = null),
      (this.state = "running"),
      this.driver.start();
  }
  pause() {
    (this.state = "paused"),
      this.updateTime(re.now()),
      (this.holdTime = this.currentTime);
  }
  complete() {
    this.state !== "running" && this.play(),
      (this.state = "finished"),
      (this.holdTime = null);
  }
  finish() {
    this.notifyFinished(),
      this.teardown(),
      (this.state = "finished"),
      this.options.onComplete?.();
  }
  cancel() {
    (this.holdTime = null),
      (this.startTime = 0),
      this.tick(0),
      this.teardown(),
      this.options.onCancel?.();
  }
  teardown() {
    (this.state = "idle"),
      this.stopDriver(),
      (this.startTime = this.holdTime = null);
  }
  stopDriver() {
    this.driver && (this.driver.stop(), (this.driver = void 0));
  }
  sample(a) {
    return (this.startTime = 0), this.tick(a, !0);
  }
  attachTimeline(a) {
    return (
      this.options.allowFlatten &&
        ((this.options.type = "keyframes"),
        (this.options.ease = "linear"),
        this.initAnimation()),
      this.driver?.stop(),
      a.observe(this)
    );
  }
}
function xx(i) {
  for (let a = 1; a < i.length; a++) i[a] ?? (i[a] = i[a - 1]);
}
const hi = (i) => (i * 180) / Math.PI,
  Tc = (i) => {
    const a = hi(Math.atan2(i[1], i[0]));
    return Ec(a);
  },
  bx = {
    x: 4,
    y: 5,
    translateX: 4,
    translateY: 5,
    scaleX: 0,
    scaleY: 3,
    scale: (i) => (Math.abs(i[0]) + Math.abs(i[3])) / 2,
    rotate: Tc,
    rotateZ: Tc,
    skewX: (i) => hi(Math.atan(i[1])),
    skewY: (i) => hi(Math.atan(i[2])),
    skew: (i) => (Math.abs(i[1]) + Math.abs(i[2])) / 2,
  },
  Ec = (i) => ((i = i % 360), i < 0 && (i += 360), i),
  Op = Tc,
  Cp = (i) => Math.sqrt(i[0] * i[0] + i[1] * i[1]),
  jp = (i) => Math.sqrt(i[4] * i[4] + i[5] * i[5]),
  Tx = {
    x: 12,
    y: 13,
    z: 14,
    translateX: 12,
    translateY: 13,
    translateZ: 14,
    scaleX: Cp,
    scaleY: jp,
    scale: (i) => (Cp(i) + jp(i)) / 2,
    rotateX: (i) => Ec(hi(Math.atan2(i[6], i[5]))),
    rotateY: (i) => Ec(hi(Math.atan2(-i[2], i[0]))),
    rotateZ: Op,
    rotate: Op,
    skewX: (i) => hi(Math.atan(i[4])),
    skewY: (i) => hi(Math.atan(i[1])),
    skew: (i) => (Math.abs(i[1]) + Math.abs(i[4])) / 2,
  };
function Ac(i) {
  return i.includes("scale") ? 1 : 0;
}
function Mc(i, a) {
  if (!i || i === "none") return Ac(a);
  const r = i.match(/^matrix3d\(([-\d.e\s,]+)\)$/u);
  let l, c;
  if (r) (l = Tx), (c = r);
  else {
    const m = i.match(/^matrix\(([-\d.e\s,]+)\)$/u);
    (l = bx), (c = m);
  }
  if (!c) return Ac(a);
  const d = l[a],
    f = c[1].split(",").map(Ax);
  return typeof d == "function" ? d(f) : f[d];
}
const Ex = (i, a) => {
  const { transform: r = "none" } = getComputedStyle(i);
  return Mc(r, a);
};
function Ax(i) {
  return parseFloat(i.trim());
}
const ua = [
    "transformPerspective",
    "x",
    "y",
    "z",
    "translateX",
    "translateY",
    "translateZ",
    "scale",
    "scaleX",
    "scaleY",
    "rotate",
    "rotateX",
    "rotateY",
    "rotateZ",
    "skew",
    "skewX",
    "skewY",
  ],
  ca = new Set([...ua, "pathRotation"]),
  Np = (i) => i === oa || i === $,
  Mx = new Set(["x", "y", "z"]),
  Rx = ua.filter((i) => !Mx.has(i));
function Dx(i) {
  const a = [];
  return (
    Rx.forEach((r) => {
      const l = i.getValue(r);
      l !== void 0 &&
        (a.push([r, l.get()]), l.set(r.startsWith("scale") ? 1 : 0));
    }),
    a
  );
}
const qn = {
  width: (
    { x: i },
    { paddingLeft: a = "0", paddingRight: r = "0", boxSizing: l },
  ) => {
    const c = i.max - i.min;
    return l === "border-box" ? c : c - parseFloat(a) - parseFloat(r);
  },
  height: (
    { y: i },
    { paddingTop: a = "0", paddingBottom: r = "0", boxSizing: l },
  ) => {
    const c = i.max - i.min;
    return l === "border-box" ? c : c - parseFloat(a) - parseFloat(r);
  },
  top: (i, { top: a }) => parseFloat(a),
  left: (i, { left: a }) => parseFloat(a),
  bottom: ({ y: i }, { top: a }) => parseFloat(a) + (i.max - i.min),
  right: ({ x: i }, { left: a }) => parseFloat(a) + (i.max - i.min),
  x: (i, { transform: a }) => Mc(a, "x"),
  y: (i, { transform: a }) => Mc(a, "y"),
};
qn.translateX = qn.x;
qn.translateY = qn.y;
const pi = new Set();
let Rc = !1,
  Dc = !1,
  Oc = !1;
function vg() {
  if (Dc) {
    const i = Array.from(pi).filter((l) => l.needsMeasurement),
      a = new Set(i.map((l) => l.element)),
      r = new Map();
    a.forEach((l) => {
      const c = Dx(l);
      c.length && (r.set(l, c), l.render());
    }),
      i.forEach((l) => l.measureInitialState()),
      a.forEach((l) => {
        l.render();
        const c = r.get(l);
        c &&
          c.forEach(([d, f]) => {
            l.getValue(d)?.set(f);
          });
      }),
      i.forEach((l) => l.measureEndState()),
      i.forEach((l) => {
        l.suspendedScrollY !== void 0 && window.scrollTo(0, l.suspendedScrollY);
      });
  }
  (Dc = !1), (Rc = !1), pi.forEach((i) => i.complete(Oc)), pi.clear();
}
function Sg() {
  pi.forEach((i) => {
    i.readKeyframes(), i.needsMeasurement && (Dc = !0);
  });
}
function Ox() {
  (Oc = !0), Sg(), vg(), (Oc = !1);
}
class nf {
  constructor(a, r, l, c, d, f = !1) {
    (this.state = "pending"),
      (this.isAsync = !1),
      (this.needsMeasurement = !1),
      (this.unresolvedKeyframes = [...a]),
      (this.onComplete = r),
      (this.name = l),
      (this.motionValue = c),
      (this.element = d),
      (this.isAsync = f);
  }
  scheduleResolve() {
    (this.state = "scheduled"),
      this.isAsync
        ? (pi.add(this),
          Rc || ((Rc = !0), Et.read(Sg), Et.resolveKeyframes(vg)))
        : (this.readKeyframes(), this.complete());
  }
  readKeyframes() {
    const {
      unresolvedKeyframes: a,
      name: r,
      element: l,
      motionValue: c,
    } = this;
    if (a[0] === null) {
      const d = c?.get(),
        f = a[a.length - 1];
      if (d !== void 0) a[0] = d;
      else if (l && r) {
        const m = l.readValue(r, f);
        m != null && (a[0] = m);
      }
      a[0] === void 0 && (a[0] = f), c && d === void 0 && c.set(a[0]);
    }
    xx(a);
  }
  setFinalKeyframe() {}
  measureInitialState() {}
  renderEndStyles() {}
  measureEndState() {}
  complete(a = !1) {
    (this.state = "complete"),
      this.onComplete(this.unresolvedKeyframes, this.finalKeyframe, a),
      pi.delete(this);
  }
  cancel() {
    this.state === "scheduled" && (pi.delete(this), (this.state = "pending"));
  }
  resume() {
    this.state === "pending" && this.scheduleResolve();
  }
}
const Cx = (i) => i.startsWith("--");
function xg(i, a, r) {
  Cx(a) ? i.style.setProperty(a, r) : (i.style[a] = r);
}
const jx = {};
function bg(i, a) {
  const r = Qy(i);
  return () => jx[a] ?? r();
}
const Nx = bg(() => window.ScrollTimeline !== void 0, "scrollTimeline"),
  Tg = bg(() => {
    try {
      document
        .createElement("div")
        .animate({ opacity: 0 }, { easing: "linear(0, 1)" });
    } catch {
      return !1;
    }
    return !0;
  }, "linearEasing"),
  ms = ([i, a, r, l]) => `cubic-bezier(${i}, ${a}, ${r}, ${l})`,
  wp = {
    linear: "linear",
    ease: "ease",
    easeIn: "ease-in",
    easeOut: "ease-out",
    easeInOut: "ease-in-out",
    circIn: ms([0, 0.65, 0.55, 1]),
    circOut: ms([0.55, 0, 1, 0.45]),
    backIn: ms([0.31, 0.01, 0.66, -0.59]),
    backOut: ms([0.33, 1.53, 0.69, 0.99]),
  };
function Eg(i, a) {
  if (i)
    return typeof i == "function"
      ? Tg()
        ? pg(i, a)
        : "ease-out"
      : sg(i)
        ? ms(i)
        : Array.isArray(i)
          ? i.map((r) => Eg(r, a) || wp.easeOut)
          : wp[i];
}
function wx(
  i,
  a,
  r,
  {
    delay: l = 0,
    duration: c = 300,
    repeat: d = 0,
    repeatType: f = "loop",
    ease: m = "easeOut",
    times: y,
  } = {},
  p = void 0,
) {
  const g = { [a]: r };
  y && (g.offset = y);
  const x = Eg(m, c);
  Array.isArray(x) && (g.easing = x);
  const b = {
    delay: l,
    duration: c,
    easing: Array.isArray(x) ? "linear" : x,
    fill: "both",
    iterations: d + 1,
    direction: f === "reverse" ? "alternate" : "normal",
  };
  return p && (b.pseudoElement = p), i.animate(g, b);
}
function Ag(i) {
  return typeof i == "function" && "applyToOptions" in i;
}
function Vx({ type: i, ...a }) {
  return Ag(i) && Tg()
    ? i.applyToOptions(a)
    : (a.duration ?? (a.duration = 300), a.ease ?? (a.ease = "easeOut"), a);
}
class Mg extends ef {
  constructor(a) {
    if (
      (super(),
      (this.finishedTime = null),
      (this.isStopped = !1),
      (this.manualStartTime = null),
      !a)
    )
      return;
    const {
      element: r,
      name: l,
      keyframes: c,
      pseudoElement: d,
      allowFlatten: f = !1,
      finalKeyframe: m,
      onComplete: y,
    } = a;
    (this.isPseudoElement = !!d),
      (this.allowFlatten = f),
      (this.options = a),
      Rr(typeof a.type != "string");
    const p = Vx(a);
    (this.animation = wx(r, l, c, p, d)),
      p.autoplay === !1 && this.animation.pause(),
      (this.animation.onfinish = () => {
        if (((this.finishedTime = this.time), !d)) {
          const g = Dr(c, this.options, m, this.speed);
          this.updateMotionValue && this.updateMotionValue(g),
            xg(r, l, g),
            this.animation.cancel();
        }
        y?.(), this.notifyFinished();
      });
  }
  play() {
    this.isStopped ||
      ((this.manualStartTime = null),
      this.animation.play(),
      this.state === "finished" && this.updateFinished());
  }
  pause() {
    this.animation.pause();
  }
  complete() {
    this.animation.finish?.();
  }
  cancel() {
    try {
      this.animation.cancel();
    } catch {}
  }
  stop() {
    if (this.isStopped) return;
    this.isStopped = !0;
    const { state: a } = this;
    a === "idle" ||
      a === "finished" ||
      (this.updateMotionValue ? this.updateMotionValue() : this.commitStyles(),
      this.isPseudoElement || this.cancel());
  }
  commitStyles() {
    const a = this.options?.element;
    !this.isPseudoElement && a?.isConnected && this.animation.commitStyles?.();
  }
  get duration() {
    const a = this.animation.effect?.getComputedTiming?.().duration || 0;
    return _e(Number(a));
  }
  get iterationDuration() {
    const { delay: a = 0 } = this.options || {};
    return this.duration + _e(a);
  }
  get time() {
    return _e(Number(this.animation.currentTime) || 0);
  }
  set time(a) {
    const r = this.finishedTime !== null;
    (this.manualStartTime = null),
      (this.finishedTime = null),
      (this.animation.currentTime = Ae(a)),
      r && this.animation.pause();
  }
  get speed() {
    return this.animation.playbackRate;
  }
  set speed(a) {
    a < 0 && (this.finishedTime = null), (this.animation.playbackRate = a);
  }
  get state() {
    return this.finishedTime !== null ? "finished" : this.animation.playState;
  }
  get startTime() {
    return this.manualStartTime ?? Number(this.animation.startTime);
  }
  set startTime(a) {
    this.manualStartTime = this.animation.startTime = a;
  }
  attachTimeline({ timeline: a, rangeStart: r, rangeEnd: l, observe: c }) {
    return (
      this.allowFlatten &&
        this.animation.effect?.updateTiming({ easing: "linear" }),
      (this.animation.onfinish = null),
      a && Nx()
        ? ((this.animation.timeline = a),
          r && (this.animation.rangeStart = r),
          l && (this.animation.rangeEnd = l),
          Le)
        : c(this)
    );
  }
}
const Rg = { anticipate: eg, backInOut: tg, circInOut: ig };
function _x(i) {
  return i in Rg;
}
function Lx(i) {
  typeof i.ease == "string" && _x(i.ease) && (i.ease = Rg[i.ease]);
}
const rc = 10;
class zx extends Mg {
  constructor(a) {
    Lx(a),
      gg(a),
      super(a),
      a.startTime !== void 0 &&
        a.autoplay !== !1 &&
        (this.startTime = a.startTime),
      (this.options = a);
  }
  updateMotionValue(a) {
    const {
      motionValue: r,
      onUpdate: l,
      onComplete: c,
      element: d,
      ...f
    } = this.options;
    if (!r) return;
    if (a !== void 0) {
      r.set(a);
      return;
    }
    const m = new yr({ ...f, autoplay: !1 }),
      y = Math.max(rc, re.now() - this.startTime),
      p = $e(0, rc, y - rc),
      g = m.sample(y).value,
      { name: x } = this.options;
    d && x && xg(d, x, g),
      r.setWithVelocity(m.sample(Math.max(0, y - p)).value, g, p),
      m.stop();
  }
}
const Vp = (i, a) =>
  a === "zIndex"
    ? !1
    : !!(
        typeof i == "number" ||
        Array.isArray(i) ||
        (typeof i == "string" &&
          (Ye.test(i) || i === "0") &&
          !i.startsWith("url("))
      );
function Ux(i) {
  const a = i[0];
  if (i.length === 1) return !0;
  for (let r = 0; r < i.length; r++) if (i[r] !== a) return !0;
}
function Bx(i, a, r, l) {
  const c = i[0];
  if (c === null) return !1;
  if (a === "display" || a === "visibility") return !0;
  const d = i[i.length - 1],
    f = Vp(c, a),
    m = Vp(d, a);
  return !f || !m ? !1 : Ux(i) || ((r === "spring" || Ag(r)) && l);
}
function Cc(i) {
  (i.duration = 0), (i.type = "keyframes");
}
const Dg = new Set([
    "opacity",
    "clipPath",
    "filter",
    "transform",
    "backgroundColor",
  ]),
  Hx = /^(?:oklch|oklab|lab|lch|color|color-mix|light-dark)\(/;
function Gx(i) {
  for (let a = 0; a < i.length; a++)
    if (typeof i[a] == "string" && Hx.test(i[a])) return !0;
  return !1;
}
const Yx = new Set([
    "color",
    "backgroundColor",
    "outlineColor",
    "fill",
    "stroke",
    "borderColor",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
  ]),
  qx = Qy(() => Object.hasOwnProperty.call(Element.prototype, "animate"));
function Xx(i) {
  const {
      motionValue: a,
      name: r,
      repeatDelay: l,
      repeatType: c,
      damping: d,
      type: f,
      keyframes: m,
    } = i,
    y = a?.owner?.current;
  if (!(y instanceof HTMLElement) && !(y instanceof SVGElement)) return !1;
  const { onUpdate: p, transformTemplate: g } = a.owner.getProps();
  return (
    qx() &&
    r &&
    (Dg.has(r) || (Yx.has(r) && Gx(m))) &&
    (r !== "transform" || !g) &&
    !p &&
    !l &&
    c !== "mirror" &&
    d !== 0 &&
    f !== "inertia"
  );
}
const kx = 40;
class Zx extends ef {
  constructor({
    autoplay: a = !0,
    delay: r = 0,
    type: l = "keyframes",
    repeat: c = 0,
    repeatDelay: d = 0,
    repeatType: f = "loop",
    keyframes: m,
    name: y,
    motionValue: p,
    element: g,
    ...x
  }) {
    super(),
      (this.stop = () => {
        this._animation && (this._animation.stop(), this.stopTimeline?.()),
          this.keyframeResolver?.cancel();
      }),
      (this.createdAt = re.now());
    const b = {
        autoplay: a,
        delay: r,
        type: l,
        repeat: c,
        repeatDelay: d,
        repeatType: f,
        name: y,
        motionValue: p,
        element: g,
        ...x,
      },
      j = g?.KeyframeResolver || nf;
    (this.keyframeResolver = new j(
      m,
      (A, R, V) => this.onKeyframesResolved(A, R, b, !V),
      y,
      p,
      g,
    )),
      this.keyframeResolver?.scheduleResolve();
  }
  onKeyframesResolved(a, r, l, c) {
    this.keyframeResolver = void 0;
    const {
      name: d,
      type: f,
      velocity: m,
      delay: y,
      isHandoff: p,
      onUpdate: g,
    } = l;
    this.resolvedAt = re.now();
    let x = !0;
    Bx(a, d, f, m) ||
      ((x = !1),
      (Xn.instantAnimations || !y) && g?.(Dr(a, l, r)),
      (a[0] = a[a.length - 1]),
      Cc(l),
      (l.repeat = 0));
    const j = {
        startTime: c
          ? this.resolvedAt
            ? this.resolvedAt - this.createdAt > kx
              ? this.resolvedAt
              : this.createdAt
            : this.createdAt
          : void 0,
        finalKeyframe: r,
        ...l,
        keyframes: a,
      },
      A = x && !p && Xx(j),
      R = j.motionValue?.owner?.current;
    let V;
    if (A)
      try {
        V = new zx({ ...j, element: R });
      } catch {
        V = new yr(j);
      }
    else V = new yr(j);
    V.finished
      .then(() => {
        this.notifyFinished();
      })
      .catch(Le),
      this.pendingTimeline &&
        ((this.stopTimeline = V.attachTimeline(this.pendingTimeline)),
        (this.pendingTimeline = void 0)),
      (this._animation = V);
  }
  get finished() {
    return this._animation ? this.animation.finished : this._finished;
  }
  then(a, r) {
    return this.finished.finally(a).then(() => {});
  }
  get animation() {
    return (
      this._animation || (this.keyframeResolver?.resume(), Ox()),
      this._animation
    );
  }
  get duration() {
    return this.animation.duration;
  }
  get iterationDuration() {
    return this.animation.iterationDuration;
  }
  get time() {
    return this.animation.time;
  }
  set time(a) {
    this.animation.time = a;
  }
  get speed() {
    return this.animation.speed;
  }
  get state() {
    return this.animation.state;
  }
  set speed(a) {
    this.animation.speed = a;
  }
  get startTime() {
    return this.animation.startTime;
  }
  attachTimeline(a) {
    return (
      this._animation
        ? (this.stopTimeline = this.animation.attachTimeline(a))
        : (this.pendingTimeline = a),
      () => this.stop()
    );
  }
  play() {
    this.animation.play();
  }
  pause() {
    this.animation.pause();
  }
  complete() {
    this.animation.complete();
  }
  cancel() {
    this._animation && this.animation.cancel(), this.keyframeResolver?.cancel();
  }
}
function Og(i, a, r, l = 0, c = 1) {
  const d = Array.from(i)
      .sort((p, g) => p.sortNodePosition(g))
      .indexOf(a),
    f = i.size,
    m = (f - 1) * l;
  return typeof r == "function" ? r(d, f) : c === 1 ? d * l : m - d * l;
}
const _p = 30,
  Kx = (i) => !isNaN(parseFloat(i));
class Px {
  constructor(a, r = {}) {
    (this.canTrackVelocity = null),
      (this.events = {}),
      (this.updateAndNotify = (l) => {
        const c = re.now();
        if (
          (this.updatedAt !== c && this.setPrevFrameValue(),
          (this.prev = this.current),
          this.setCurrent(l),
          this.current !== this.prev &&
            (this.events.change?.notify(this.current), this.dependents))
        )
          for (const d of this.dependents) d.dirty();
      }),
      (this.hasAnimated = !1),
      this.setCurrent(a),
      (this.owner = r.owner);
  }
  setCurrent(a) {
    (this.current = a),
      (this.updatedAt = re.now()),
      this.canTrackVelocity === null &&
        a !== void 0 &&
        (this.canTrackVelocity = Kx(this.current));
  }
  setPrevFrameValue(a = this.current) {
    (this.prevFrameValue = a), (this.prevUpdatedAt = this.updatedAt);
  }
  onChange(a) {
    return this.on("change", a);
  }
  on(a, r) {
    this.events[a] || (this.events[a] = new Pc());
    const l = this.events[a].add(r);
    return a === "change"
      ? () => {
          l(),
            Et.read(() => {
              this.events.change.getSize() || this.stop();
            });
        }
      : l;
  }
  clearListeners() {
    for (const a in this.events) this.events[a].clear();
  }
  attach(a, r) {
    (this.passiveEffect = a), (this.stopPassiveEffect = r);
  }
  set(a) {
    this.passiveEffect
      ? this.passiveEffect(a, this.updateAndNotify)
      : this.updateAndNotify(a);
  }
  setWithVelocity(a, r, l) {
    this.set(r),
      (this.prev = void 0),
      (this.prevFrameValue = a),
      (this.prevUpdatedAt = this.updatedAt - l);
  }
  jump(a, r = !0) {
    this.updateAndNotify(a),
      (this.prev = a),
      (this.prevUpdatedAt = this.prevFrameValue = void 0),
      r && this.stop(),
      this.stopPassiveEffect && this.stopPassiveEffect();
  }
  dirty() {
    this.events.change?.notify(this.current);
  }
  addDependent(a) {
    this.dependents || (this.dependents = new Set()), this.dependents.add(a);
  }
  removeDependent(a) {
    this.dependents && this.dependents.delete(a);
  }
  get() {
    return this.current;
  }
  getPrevious() {
    return this.prev;
  }
  getVelocity() {
    const a = re.now();
    if (
      !this.canTrackVelocity ||
      this.prevFrameValue === void 0 ||
      a - this.updatedAt > _p
    )
      return 0;
    const r = Math.min(this.updatedAt - this.prevUpdatedAt, _p);
    return Jy(parseFloat(this.current) - parseFloat(this.prevFrameValue), r);
  }
  start(a) {
    return (
      this.stop(),
      new Promise((r) => {
        (this.hasAnimated = !0),
          (this.animation = a(r)),
          this.events.animationStart && this.events.animationStart.notify();
      }).then(() => {
        this.events.animationComplete && this.events.animationComplete.notify(),
          this.clearAnimation();
      })
    );
  }
  stop() {
    this.animation &&
      (this.animation.stop(),
      this.events.animationCancel && this.events.animationCancel.notify()),
      this.clearAnimation();
  }
  isAnimating() {
    return !!this.animation;
  }
  clearAnimation() {
    delete this.animation;
  }
  destroy() {
    this.dependents?.clear(),
      this.events.destroy?.notify(),
      this.clearListeners(),
      this.stop(),
      this.stopPassiveEffect && this.stopPassiveEffect();
  }
}
function gi(i, a) {
  return new Px(i, a);
}
function Cg(i, a) {
  if (i?.inherit && a) {
    const { inherit: r, ...l } = i;
    return { ...a, ...l };
  }
  return i;
}
function af(i, a) {
  const r = i?.[a] ?? i?.default ?? i;
  return r !== i ? Cg(r, i) : r;
}
const Qx = { type: "spring", stiffness: 500, damping: 25, restSpeed: 10 },
  Jx = (i) => ({
    type: "spring",
    stiffness: 550,
    damping: i === 0 ? 2 * Math.sqrt(550) : 30,
    restSpeed: 10,
  }),
  Fx = { type: "keyframes", duration: 0.8 },
  $x = { type: "keyframes", ease: [0.25, 0.1, 0.35, 1], duration: 0.3 },
  Wx = (i, { keyframes: a }) =>
    a.length > 2
      ? Fx
      : ca.has(i)
        ? i.startsWith("scale")
          ? Jx(a[1])
          : Qx
        : $x,
  Ix = new Set([
    "when",
    "delay",
    "delayChildren",
    "staggerChildren",
    "staggerDirection",
    "repeat",
    "repeatType",
    "repeatDelay",
    "from",
    "elapsed",
  ]);
function tb(i) {
  for (const a in i) if (!Ix.has(a)) return !0;
  return !1;
}
const sf =
    (i, a, r, l = {}, c, d) =>
    (f) => {
      const m = af(l, i) || {},
        y = m.delay || l.delay || 0;
      let { elapsed: p = 0 } = l;
      p = p - Ae(y);
      const g = {
        keyframes: Array.isArray(r) ? r : [null, r],
        ease: "easeOut",
        velocity: a.getVelocity(),
        ...m,
        delay: -p,
        onUpdate: (b) => {
          a.set(b), m.onUpdate && m.onUpdate(b);
        },
        onComplete: () => {
          f(), m.onComplete && m.onComplete();
        },
        name: i,
        motionValue: a,
        element: d ? void 0 : c,
      };
      tb(m) || Object.assign(g, Wx(i, g)),
        g.duration && (g.duration = Ae(g.duration)),
        g.repeatDelay && (g.repeatDelay = Ae(g.repeatDelay)),
        g.from !== void 0 && (g.keyframes[0] = g.from);
      let x = !1;
      if (
        ((g.type === !1 || (g.duration === 0 && !g.repeatDelay)) &&
          (Cc(g), g.delay === 0 && (x = !0)),
        (Xn.instantAnimations ||
          Xn.skipAnimations ||
          c?.shouldSkipAnimations ||
          m.skipAnimations) &&
          ((x = !0), Cc(g), (g.delay = 0)),
        (g.allowFlatten = !m.type && !m.ease),
        x && !d && a.get() !== void 0)
      ) {
        const b = Dr(g.keyframes, m);
        if (b !== void 0) {
          Et.update(() => {
            g.onUpdate(b), g.onComplete();
          });
          return;
        }
      }
      return m.isSync ? new yr(g) : new Zx(g);
    },
  eb = /^var\(--(?:([\w-]+)|([\w-]+), ?([a-zA-Z\d ()%#.,-]+))\)/u;
function nb(i) {
  const a = eb.exec(i);
  if (!a) return [,];
  const [, r, l, c] = a;
  return [`--${r ?? l}`, c];
}
function jg(i, a, r = 1) {
  const [l, c] = nb(i);
  if (!l) return;
  const d = window.getComputedStyle(a).getPropertyValue(l);
  if (d) {
    const f = d.trim();
    return Zy(f) ? parseFloat(f) : f;
  }
  return Fc(c) ? jg(c, a, r + 1) : c;
}
function Lp(i) {
  const a = [{}, {}];
  return (
    i?.values.forEach((r, l) => {
      (a[0][l] = r.get()), (a[1][l] = r.getVelocity());
    }),
    a
  );
}
function lf(i, a, r, l) {
  if (typeof a == "function") {
    const [c, d] = Lp(l);
    a = a(r !== void 0 ? r : i.custom, c, d);
  }
  if (
    (typeof a == "string" && (a = i.variants && i.variants[a]),
    typeof a == "function")
  ) {
    const [c, d] = Lp(l);
    a = a(r !== void 0 ? r : i.custom, c, d);
  }
  return a;
}
function yi(i, a, r) {
  const l = i.getProps();
  return lf(l, a, r !== void 0 ? r : l.custom, i);
}
const Ng = new Set([
    "width",
    "height",
    "top",
    "left",
    "right",
    "bottom",
    ...ua,
  ]),
  jc = (i) => Array.isArray(i);
function ib(i, a, r) {
  i.hasValue(a) ? i.getValue(a).set(r) : i.addValue(a, gi(r));
}
function ab(i) {
  return jc(i) ? i[i.length - 1] || 0 : i;
}
function sb(i, a) {
  const r = yi(i, a);
  let { transitionEnd: l = {}, transition: c = {}, ...d } = r || {};
  d = { ...d, ...l };
  for (const f in d) {
    const m = ab(d[f]);
    ib(i, f, m);
  }
}
const ne = (i) => !!(i && i.getVelocity);
function lb(i) {
  return !!(ne(i) && i.add);
}
function Nc(i, a) {
  const r = i.getValue("willChange");
  if (lb(r)) return r.add(a);
  if (!r && Xn.WillChange) {
    const l = new Xn.WillChange("auto");
    i.addValue("willChange", l), l.add(a);
  }
}
function rf(i) {
  return i.replace(/([A-Z])/g, (a) => `-${a.toLowerCase()}`);
}
const rb = "framerAppearId",
  wg = "data-" + rf(rb);
function Vg(i) {
  return i.props[wg];
}
function ob({ protectedKeys: i, needsAnimating: a }, r) {
  const l = i.hasOwnProperty(r) && a[r] !== !0;
  return (a[r] = !1), l;
}
function _g(i, a, { delay: r = 0, transitionOverride: l, type: c } = {}) {
  let { transition: d, transitionEnd: f, ...m } = a;
  const y = i.getDefaultTransition();
  d = d ? Cg(d, y) : y;
  const p = d?.reduceMotion,
    g = d?.skipAnimations;
  l && (d = l);
  const x = [],
    b = c && i.animationState && i.animationState.getState()[c],
    j = d?.path;
  j && j.animateVisualElement(i, m, d, r, x);
  for (const A in m) {
    const R = i.getValue(A, i.latestValues[A] ?? null),
      V = m[A];
    if (V === void 0 || (b && ob(b, A))) continue;
    const L = { delay: r, ...af(d || {}, A) };
    g && (L.skipAnimations = !0);
    const _ = R.get();
    if (
      _ !== void 0 &&
      !R.isAnimating() &&
      !Array.isArray(V) &&
      V === _ &&
      !L.velocity
    ) {
      Et.update(() => R.set(V));
      continue;
    }
    let H = !1;
    if (window.MotionHandoffAnimation) {
      const tt = Vg(i);
      if (tt) {
        const et = window.MotionHandoffAnimation(tt, A, Et);
        et !== null && ((L.startTime = et), (H = !0));
      }
    }
    Nc(i, A);
    const X = p ?? i.shouldReduceMotion;
    R.start(sf(A, R, V, X && Ng.has(A) ? { type: !1 } : L, i, H));
    const k = R.animation;
    k && x.push(k);
  }
  if (f) {
    const A = () =>
      Et.update(() => {
        f && sb(i, f);
      });
    x.length ? Promise.all(x).then(A) : A();
  }
  return x;
}
function wc(i, a, r = {}) {
  const l = yi(i, a, r.type === "exit" ? i.presenceContext?.custom : void 0);
  let { transition: c = i.getDefaultTransition() || {} } = l || {};
  r.transitionOverride && (c = r.transitionOverride);
  const d = l ? () => Promise.all(_g(i, l, r)) : () => Promise.resolve(),
    f =
      i.variantChildren && i.variantChildren.size
        ? (y = 0) => {
            const {
              delayChildren: p = 0,
              staggerChildren: g,
              staggerDirection: x,
            } = c;
            return ub(i, a, y, p, g, x, r);
          }
        : () => Promise.resolve(),
    { when: m } = c;
  if (m) {
    const [y, p] = m === "beforeChildren" ? [d, f] : [f, d];
    return y().then(() => p());
  } else return Promise.all([d(), f(r.delay)]);
}
function ub(i, a, r = 0, l = 0, c = 0, d = 1, f) {
  const m = [];
  for (const y of i.variantChildren)
    y.notify("AnimationStart", a),
      m.push(
        wc(y, a, {
          ...f,
          delay:
            r +
            (typeof l == "function" ? 0 : l) +
            Og(i.variantChildren, y, l, c, d),
        }).then(() => y.notify("AnimationComplete", a)),
      );
  return Promise.all(m);
}
function cb(i, a, r = {}) {
  i.notify("AnimationStart", a);
  let l;
  if (Array.isArray(a)) {
    const c = a.map((d) => wc(i, d, r));
    l = Promise.all(c);
  } else if (typeof a == "string") l = wc(i, a, r);
  else {
    const c = typeof a == "function" ? yi(i, a, r.custom) : a;
    l = Promise.all(_g(i, c, r));
  }
  return l.then(() => {
    i.notify("AnimationComplete", a);
  });
}
const fb = { test: (i) => i === "auto", parse: (i) => i },
  Lg = (i) => (a) => a.test(i),
  zg = [oa, $, Fe, mn, US, zS, fb],
  zp = (i) => zg.find(Lg(i));
function db(i) {
  return typeof i == "number"
    ? i === 0
    : i !== null
      ? i === "none" || i === "0" || Py(i)
      : !0;
}
const hb = new Set(["brightness", "contrast", "saturate", "opacity"]);
function mb(i) {
  const [a, r] = i.slice(0, -1).split("(");
  if (a === "drop-shadow") return i;
  const [l] = r.match($c) || [];
  if (!l) return i;
  const c = r.replace(l, "");
  let d = hb.has(a) ? 1 : 0;
  return l !== r && (d *= 100), a + "(" + d + c + ")";
}
const pb = /\b([a-z-]*)\(.*?\)/gu,
  Vc = {
    ...Ye,
    getAnimatableNone: (i) => {
      const a = i.match(pb);
      return a ? a.map(mb).join(" ") : i;
    },
  },
  _c = {
    ...Ye,
    getAnimatableNone: (i) => {
      const a = Ye.parse(i);
      return Ye.createTransformer(i)(
        a.map((l) =>
          typeof l == "number"
            ? 0
            : typeof l == "object"
              ? { ...l, alpha: 1 }
              : l,
        ),
      );
    },
  },
  Up = { ...oa, transform: Math.round },
  yb = {
    rotate: mn,
    pathRotation: mn,
    rotateX: mn,
    rotateY: mn,
    rotateZ: mn,
    scale: Wl,
    scaleX: Wl,
    scaleY: Wl,
    scaleZ: Wl,
    skew: mn,
    skewX: mn,
    skewY: mn,
    distance: $,
    translateX: $,
    translateY: $,
    translateZ: $,
    x: $,
    y: $,
    z: $,
    perspective: $,
    transformPerspective: $,
    opacity: bs,
    originX: Ep,
    originY: Ep,
    originZ: $,
  },
  gr = {
    borderWidth: $,
    borderTopWidth: $,
    borderRightWidth: $,
    borderBottomWidth: $,
    borderLeftWidth: $,
    borderRadius: $,
    borderTopLeftRadius: $,
    borderTopRightRadius: $,
    borderBottomRightRadius: $,
    borderBottomLeftRadius: $,
    width: $,
    maxWidth: $,
    height: $,
    maxHeight: $,
    top: $,
    right: $,
    bottom: $,
    left: $,
    inset: $,
    insetBlock: $,
    insetBlockStart: $,
    insetBlockEnd: $,
    insetInline: $,
    insetInlineStart: $,
    insetInlineEnd: $,
    padding: $,
    paddingTop: $,
    paddingRight: $,
    paddingBottom: $,
    paddingLeft: $,
    paddingBlock: $,
    paddingBlockStart: $,
    paddingBlockEnd: $,
    paddingInline: $,
    paddingInlineStart: $,
    paddingInlineEnd: $,
    margin: $,
    marginTop: $,
    marginRight: $,
    marginBottom: $,
    marginLeft: $,
    marginBlock: $,
    marginBlockStart: $,
    marginBlockEnd: $,
    marginInline: $,
    marginInlineStart: $,
    marginInlineEnd: $,
    fontSize: $,
    backgroundPositionX: $,
    backgroundPositionY: $,
    ...yb,
    zIndex: Up,
    fillOpacity: bs,
    strokeOpacity: bs,
    numOctaves: Up,
  },
  gb = {
    ...gr,
    color: qt,
    backgroundColor: qt,
    outlineColor: qt,
    fill: qt,
    stroke: qt,
    borderColor: qt,
    borderTopColor: qt,
    borderRightColor: qt,
    borderBottomColor: qt,
    borderLeftColor: qt,
    filter: Vc,
    WebkitFilter: Vc,
    mask: _c,
    WebkitMask: _c,
  },
  Ug = (i) => gb[i],
  vb = new Set([Vc, _c]);
function Bg(i, a) {
  let r = Ug(i);
  return (
    vb.has(r) || (r = Ye), r.getAnimatableNone ? r.getAnimatableNone(a) : void 0
  );
}
const Sb = new Set(["auto", "none", "0"]);
function xb(i, a, r) {
  let l = 0,
    c;
  for (; l < i.length && !c; ) {
    const d = i[l];
    typeof d == "string" && !Sb.has(d) && ra(d).values.length && (c = i[l]),
      l++;
  }
  if (c && r) for (const d of a) i[d] = Bg(r, c);
}
class bb extends nf {
  constructor(a, r, l, c, d) {
    super(a, r, l, c, d, !0);
  }
  readKeyframes() {
    const { unresolvedKeyframes: a, element: r, name: l } = this;
    if (!r || !r.current) return;
    super.readKeyframes();
    for (let g = 0; g < a.length; g++) {
      let x = a[g];
      if (typeof x == "string" && ((x = x.trim()), Fc(x))) {
        const b = jg(x, r.current);
        b !== void 0 && (a[g] = b),
          g === a.length - 1 && (this.finalKeyframe = x);
      }
    }
    if ((this.resolveNoneKeyframes(), !Ng.has(l) || a.length !== 2)) return;
    const [c, d] = a,
      f = zp(c),
      m = zp(d),
      y = Tp(c),
      p = Tp(d);
    if (y !== p && qn[l]) {
      this.needsMeasurement = !0;
      return;
    }
    if (f !== m)
      if (Np(f) && Np(m))
        for (let g = 0; g < a.length; g++) {
          const x = a[g];
          typeof x == "string" && (a[g] = parseFloat(x));
        }
      else qn[l] && (this.needsMeasurement = !0);
  }
  resolveNoneKeyframes() {
    const { unresolvedKeyframes: a, name: r } = this,
      l = [];
    for (let c = 0; c < a.length; c++) (a[c] === null || db(a[c])) && l.push(c);
    l.length && xb(a, l, r);
  }
  measureInitialState() {
    const { element: a, unresolvedKeyframes: r, name: l } = this;
    if (!a || !a.current) return;
    l === "height" && (this.suspendedScrollY = window.pageYOffset),
      (this.measuredOrigin = qn[l](
        a.measureViewportBox(),
        window.getComputedStyle(a.current),
      )),
      (r[0] = this.measuredOrigin);
    const c = r[r.length - 1];
    c !== void 0 && a.getValue(l, c).jump(c, !1);
  }
  measureEndState() {
    const { element: a, name: r, unresolvedKeyframes: l } = this;
    if (!a || !a.current) return;
    const c = a.getValue(r);
    c && c.jump(this.measuredOrigin, !1);
    const d = l.length - 1,
      f = l[d];
    (l[d] = qn[r](a.measureViewportBox(), window.getComputedStyle(a.current))),
      f !== null && this.finalKeyframe === void 0 && (this.finalKeyframe = f),
      this.removedTransforms?.length &&
        this.removedTransforms.forEach(([m, y]) => {
          a.getValue(m).set(y);
        }),
      this.resolveNoneKeyframes();
  }
}
const of = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
];
function Hg(i, a, r) {
  if (i == null) return [];
  if (i instanceof EventTarget) return [i];
  if (typeof i == "string") {
    let l = document;
    const c = r?.[i] ?? l.querySelectorAll(i);
    return c ? Array.from(c) : [];
  }
  return Array.from(i).filter((l) => l != null);
}
const Lc = (i, a) => (a && typeof i == "number" ? a.transform(i) : i);
function ar(i) {
  return Ky(i) && "offsetHeight" in i && !("ownerSVGElement" in i);
}
const { schedule: uf } = lg(queueMicrotask, !1),
  Ge = { x: !1, y: !1 };
function Gg() {
  return Ge.x || Ge.y;
}
function Tb(i) {
  return i === "x" || i === "y"
    ? Ge[i]
      ? null
      : ((Ge[i] = !0),
        () => {
          Ge[i] = !1;
        })
    : Ge.x || Ge.y
      ? null
      : ((Ge.x = Ge.y = !0),
        () => {
          Ge.x = Ge.y = !1;
        });
}
function Yg(i, a) {
  const r = Hg(i),
    l = new AbortController(),
    c = { passive: !0, ...a, signal: l.signal };
  return [r, c, () => l.abort()];
}
function Eb(i) {
  return !(i.pointerType === "touch" || Gg());
}
function Ab(i, a, r = {}) {
  const [l, c, d] = Yg(i, r);
  return (
    l.forEach((f) => {
      let m = !1,
        y = !1,
        p;
      const g = () => {
          f.removeEventListener("pointerleave", A);
        },
        x = (V) => {
          p && (p(V), (p = void 0)), g();
        },
        b = (V) => {
          (m = !1),
            window.removeEventListener("pointerup", b),
            window.removeEventListener("pointercancel", b),
            y && ((y = !1), x(V));
        },
        j = () => {
          (m = !0),
            window.addEventListener("pointerup", b, c),
            window.addEventListener("pointercancel", b, c);
        },
        A = (V) => {
          if (V.pointerType !== "touch") {
            if (m) {
              y = !0;
              return;
            }
            x(V);
          }
        },
        R = (V) => {
          if (!Eb(V)) return;
          y = !1;
          const L = a(f, V);
          typeof L == "function" &&
            ((p = L), f.addEventListener("pointerleave", A, c));
        };
      f.addEventListener("pointerenter", R, c),
        f.addEventListener("pointerdown", j, c);
    }),
    d
  );
}
const qg = (i, a) => (a ? (i === a ? !0 : qg(i, a.parentElement)) : !1),
  cf = (i) =>
    i.pointerType === "mouse"
      ? typeof i.button != "number" || i.button <= 0
      : i.isPrimary !== !1,
  Mb = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);
function Rb(i) {
  return Mb.has(i.tagName) || i.isContentEditable === !0;
}
const Db = new Set(["INPUT", "SELECT", "TEXTAREA"]);
function Ob(i) {
  return Db.has(i.tagName) || i.isContentEditable === !0;
}
const sr = new WeakSet();
function Bp(i) {
  return (a) => {
    a.key === "Enter" && i(a);
  };
}
function oc(i, a) {
  i.dispatchEvent(
    new PointerEvent("pointer" + a, { isPrimary: !0, bubbles: !0 }),
  );
}
const Cb = (i, a) => {
  const r = i.currentTarget;
  if (!r) return;
  const l = Bp(() => {
    if (sr.has(r)) return;
    oc(r, "down");
    const c = Bp(() => {
        oc(r, "up");
      }),
      d = () => oc(r, "cancel");
    r.addEventListener("keyup", c, a), r.addEventListener("blur", d, a);
  });
  r.addEventListener("keydown", l, a),
    r.addEventListener("blur", () => r.removeEventListener("keydown", l), a);
};
function Hp(i) {
  return cf(i) && !Gg();
}
const Gp = new WeakSet();
function jb(i, a, r = {}) {
  const [l, c, d] = Yg(i, r),
    f = (m) => {
      const y = m.currentTarget;
      if (!Hp(m) || Gp.has(m)) return;
      sr.add(y), r.stopPropagation && Gp.add(m);
      const p = a(y, m),
        g = { ...c, capture: !0 },
        x = (A, R) => {
          window.removeEventListener("pointerup", b, g),
            window.removeEventListener("pointercancel", j, g),
            sr.has(y) && sr.delete(y),
            Hp(A) && typeof p == "function" && p(A, { success: R });
        },
        b = (A) => {
          x(
            A,
            y === window ||
              y === document ||
              r.useGlobalTarget ||
              qg(y, A.target),
          );
        },
        j = (A) => {
          x(A, !1);
        };
      window.addEventListener("pointerup", b, g),
        window.addEventListener("pointercancel", j, g);
    };
  return (
    l.forEach((m) => {
      (r.useGlobalTarget ? window : m).addEventListener("pointerdown", f, c),
        ar(m) &&
          (m.addEventListener("focus", (p) => Cb(p, c)),
          !Rb(m) && !m.hasAttribute("tabindex") && (m.tabIndex = 0));
    }),
    d
  );
}
function ff(i) {
  return Ky(i) && "ownerSVGElement" in i;
}
const lr = new WeakMap();
let rr;
const Xg = (i, a, r) => (l, c) =>
    c && c[0]
      ? c[0][i + "Size"]
      : ff(l) && "getBBox" in l
        ? l.getBBox()[a]
        : l[r],
  Nb = Xg("inline", "width", "offsetWidth"),
  wb = Xg("block", "height", "offsetHeight");
function Vb({ target: i, borderBoxSize: a }) {
  lr.get(i)?.forEach((r) => {
    r(i, {
      get width() {
        return Nb(i, a);
      },
      get height() {
        return wb(i, a);
      },
    });
  });
}
function _b(i) {
  i.forEach(Vb);
}
function Lb() {
  typeof ResizeObserver > "u" || (rr = new ResizeObserver(_b));
}
function zb(i, a) {
  rr || Lb();
  const r = Hg(i);
  return (
    r.forEach((l) => {
      let c = lr.get(l);
      c || ((c = new Set()), lr.set(l, c)), c.add(a), rr?.observe(l);
    }),
    () => {
      r.forEach((l) => {
        const c = lr.get(l);
        c?.delete(a), c?.size || rr?.unobserve(l);
      });
    }
  );
}
const or = new Set();
let sa;
function Ub() {
  (sa = () => {
    const i = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return window.innerHeight;
      },
    };
    or.forEach((a) => a(i));
  }),
    window.addEventListener("resize", sa);
}
function Bb(i) {
  return (
    or.add(i),
    sa || Ub(),
    () => {
      or.delete(i),
        !or.size &&
          typeof sa == "function" &&
          (window.removeEventListener("resize", sa), (sa = void 0));
    }
  );
}
function Yp(i, a) {
  return typeof i == "function" ? Bb(i) : zb(i, a);
}
function Hb(i) {
  return ff(i) && i.tagName === "svg";
}
const Gb = [...zg, qt, Ye],
  Yb = (i) => Gb.find(Lg(i)),
  qp = () => ({ translate: 0, scale: 1, origin: 0, originPoint: 0 }),
  la = () => ({ x: qp(), y: qp() }),
  Xp = () => ({ min: 0, max: 0 }),
  Zt = () => ({ x: Xp(), y: Xp() }),
  qb = new WeakMap();
function Or(i) {
  return i !== null && typeof i == "object" && typeof i.start == "function";
}
function Ts(i) {
  return typeof i == "string" || Array.isArray(i);
}
const df = [
    "animate",
    "whileInView",
    "whileFocus",
    "whileHover",
    "whileTap",
    "whileDrag",
    "exit",
  ],
  hf = ["initial", ...df];
function Cr(i) {
  return Or(i.animate) || hf.some((a) => Ts(i[a]));
}
function kg(i) {
  return !!(Cr(i) || i.variants);
}
function Xb(i, a, r) {
  for (const l in a) {
    const c = a[l],
      d = r[l];
    if (ne(c)) i.addValue(l, c);
    else if (ne(d)) i.addValue(l, gi(c, { owner: i }));
    else if (d !== c)
      if (i.hasValue(l)) {
        const f = i.getValue(l);
        f.liveStyle === !0 ? f.jump(c) : f.hasAnimated || f.set(c);
      } else {
        const f = i.getStaticValue(l);
        i.addValue(l, gi(f !== void 0 ? f : c, { owner: i }));
      }
  }
  for (const l in r) a[l] === void 0 && i.removeValue(l);
  return a;
}
const vr = { current: null },
  mf = { current: !1 },
  kb = typeof window < "u";
function Zg() {
  if (((mf.current = !0), !!kb))
    if (window.matchMedia) {
      const i = window.matchMedia("(prefers-reduced-motion)"),
        a = () => (vr.current = i.matches);
      i.addEventListener("change", a), a();
    } else vr.current = !1;
}
const kp = [
  "AnimationStart",
  "AnimationComplete",
  "Update",
  "BeforeLayoutMeasure",
  "LayoutMeasure",
  "LayoutAnimationStart",
  "LayoutAnimationComplete",
];
let Sr = {};
function Kg(i) {
  Sr = i;
}
function Zb() {
  return Sr;
}
class Kb {
  scrapeMotionValuesFromProps(a, r, l) {
    return {};
  }
  constructor(
    {
      parent: a,
      props: r,
      presenceContext: l,
      reducedMotionConfig: c,
      skipAnimations: d,
      blockInitialAnimation: f,
      visualState: m,
    },
    y = {},
  ) {
    (this.current = null),
      (this.children = new Set()),
      (this.isVariantNode = !1),
      (this.isControllingVariants = !1),
      (this.shouldReduceMotion = null),
      (this.shouldSkipAnimations = !1),
      (this.values = new Map()),
      (this.KeyframeResolver = nf),
      (this.features = {}),
      (this.valueSubscriptions = new Map()),
      (this.prevMotionValues = {}),
      (this.hasBeenMounted = !1),
      (this.events = {}),
      (this.propEventSubscriptions = {}),
      (this.notifyUpdate = () => this.notify("Update", this.latestValues)),
      (this.render = () => {
        this.current &&
          (this.triggerBuild(),
          this.renderInstance(
            this.current,
            this.renderState,
            this.props.style,
            this.projection,
          ));
      }),
      (this.renderScheduledAt = 0),
      (this.scheduleRender = () => {
        const j = re.now();
        this.renderScheduledAt < j &&
          ((this.renderScheduledAt = j), Et.render(this.render, !1, !0));
      });
    const { latestValues: p, renderState: g } = m;
    (this.latestValues = p),
      (this.baseTarget = { ...p }),
      (this.initialValues = r.initial ? { ...p } : {}),
      (this.renderState = g),
      (this.parent = a),
      (this.props = r),
      (this.presenceContext = l),
      (this.depth = a ? a.depth + 1 : 0),
      (this.reducedMotionConfig = c),
      (this.skipAnimationsConfig = d),
      (this.options = y),
      (this.blockInitialAnimation = !!f),
      (this.isControllingVariants = Cr(r)),
      (this.isVariantNode = kg(r)),
      this.isVariantNode && (this.variantChildren = new Set()),
      (this.manuallyAnimateOnMount = !!(a && a.current));
    const { willChange: x, ...b } = this.scrapeMotionValuesFromProps(
      r,
      {},
      this,
    );
    for (const j in b) {
      const A = b[j];
      p[j] !== void 0 && ne(A) && A.set(p[j]);
    }
  }
  mount(a) {
    if (this.hasBeenMounted)
      for (const r in this.initialValues)
        this.values.get(r)?.jump(this.initialValues[r]),
          (this.latestValues[r] = this.initialValues[r]);
    (this.current = a),
      qb.set(a, this),
      this.projection && !this.projection.instance && this.projection.mount(a),
      this.parent &&
        this.isVariantNode &&
        !this.isControllingVariants &&
        (this.removeFromVariantTree = this.parent.addVariantChild(this)),
      this.values.forEach((r, l) => this.bindToMotionValue(l, r)),
      this.reducedMotionConfig === "never"
        ? (this.shouldReduceMotion = !1)
        : this.reducedMotionConfig === "always"
          ? (this.shouldReduceMotion = !0)
          : (mf.current || Zg(), (this.shouldReduceMotion = vr.current)),
      (this.shouldSkipAnimations = this.skipAnimationsConfig ?? !1),
      this.parent?.addChild(this),
      this.update(this.props, this.presenceContext),
      (this.hasBeenMounted = !0);
  }
  unmount() {
    this.projection && this.projection.unmount(),
      pn(this.notifyUpdate),
      pn(this.render),
      this.valueSubscriptions.forEach((a) => a()),
      this.valueSubscriptions.clear(),
      this.removeFromVariantTree && this.removeFromVariantTree(),
      this.parent?.removeChild(this);
    for (const a in this.events) this.events[a].clear();
    for (const a in this.features) {
      const r = this.features[a];
      r && (r.unmount(), (r.isMounted = !1));
    }
    this.current = null;
  }
  addChild(a) {
    this.children.add(a),
      this.enteringChildren ?? (this.enteringChildren = new Set()),
      this.enteringChildren.add(a);
  }
  removeChild(a) {
    this.children.delete(a),
      this.enteringChildren && this.enteringChildren.delete(a);
  }
  bindToMotionValue(a, r) {
    if (
      (this.valueSubscriptions.has(a) && this.valueSubscriptions.get(a)(),
      r.accelerate && Dg.has(a) && this.current instanceof HTMLElement)
    ) {
      const {
          factory: f,
          keyframes: m,
          times: y,
          ease: p,
          duration: g,
        } = r.accelerate,
        x = new Mg({
          element: this.current,
          name: a,
          keyframes: m,
          times: y,
          ease: p,
          duration: Ae(g),
        }),
        b = f(x);
      this.valueSubscriptions.set(a, () => {
        b(), x.cancel();
      });
      return;
    }
    const l = ca.has(a);
    l && this.onBindTransform && this.onBindTransform();
    const c = r.on("change", (f) => {
      (this.latestValues[a] = f),
        this.props.onUpdate && Et.preRender(this.notifyUpdate),
        l && this.projection && (this.projection.isTransformDirty = !0),
        this.scheduleRender();
    });
    let d;
    typeof window < "u" &&
      window.MotionCheckAppearSync &&
      (d = window.MotionCheckAppearSync(this, a, r)),
      this.valueSubscriptions.set(a, () => {
        c(), d && d();
      });
  }
  sortNodePosition(a) {
    return !this.current ||
      !this.sortInstanceNodePosition ||
      this.type !== a.type
      ? 0
      : this.sortInstanceNodePosition(this.current, a.current);
  }
  updateFeatures() {
    let a = "animation";
    for (a in Sr) {
      const r = Sr[a];
      if (!r) continue;
      const { isEnabled: l, Feature: c } = r;
      if (
        (!this.features[a] &&
          c &&
          l(this.props) &&
          (this.features[a] = new c(this)),
        this.features[a])
      ) {
        const d = this.features[a];
        d.isMounted ? d.update() : (d.mount(), (d.isMounted = !0));
      }
    }
  }
  triggerBuild() {
    this.build(this.renderState, this.latestValues, this.props);
  }
  measureViewportBox() {
    return this.current
      ? this.measureInstanceViewportBox(this.current, this.props)
      : Zt();
  }
  getStaticValue(a) {
    return this.latestValues[a];
  }
  setStaticValue(a, r) {
    this.latestValues[a] = r;
  }
  update(a, r) {
    (a.transformTemplate || this.props.transformTemplate) &&
      this.scheduleRender(),
      (this.prevProps = this.props),
      (this.props = a),
      (this.prevPresenceContext = this.presenceContext),
      (this.presenceContext = r);
    for (let l = 0; l < kp.length; l++) {
      const c = kp[l];
      this.propEventSubscriptions[c] &&
        (this.propEventSubscriptions[c](),
        delete this.propEventSubscriptions[c]);
      const d = "on" + c,
        f = a[d];
      f && (this.propEventSubscriptions[c] = this.on(c, f));
    }
    (this.prevMotionValues = Xb(
      this,
      this.scrapeMotionValuesFromProps(a, this.prevProps || {}, this),
      this.prevMotionValues,
    )),
      this.handleChildMotionValue && this.handleChildMotionValue();
  }
  getProps() {
    return this.props;
  }
  getVariant(a) {
    return this.props.variants ? this.props.variants[a] : void 0;
  }
  getDefaultTransition() {
    return this.props.transition;
  }
  getTransformPagePoint() {
    return this.props.transformPagePoint;
  }
  getClosestVariantNode() {
    return this.isVariantNode
      ? this
      : this.parent
        ? this.parent.getClosestVariantNode()
        : void 0;
  }
  addVariantChild(a) {
    const r = this.getClosestVariantNode();
    if (r)
      return (
        r.variantChildren && r.variantChildren.add(a),
        () => r.variantChildren.delete(a)
      );
  }
  addValue(a, r) {
    const l = this.values.get(a);
    r !== l &&
      (l && this.removeValue(a),
      this.bindToMotionValue(a, r),
      this.values.set(a, r),
      (this.latestValues[a] = r.get()));
  }
  removeValue(a) {
    this.values.delete(a);
    const r = this.valueSubscriptions.get(a);
    r && (r(), this.valueSubscriptions.delete(a)),
      delete this.latestValues[a],
      this.removeValueFromRenderState(a, this.renderState);
  }
  hasValue(a) {
    return this.values.has(a);
  }
  getValue(a, r) {
    if (this.props.values && this.props.values[a]) return this.props.values[a];
    let l = this.values.get(a);
    return (
      l === void 0 &&
        r !== void 0 &&
        ((l = gi(r === null ? void 0 : r, { owner: this })),
        this.addValue(a, l)),
      l
    );
  }
  readValue(a, r) {
    let l =
      this.latestValues[a] !== void 0 || !this.current
        ? this.latestValues[a]
        : (this.getBaseTargetFromProps(this.props, a) ??
          this.readValueFromInstance(this.current, a, this.options));
    return (
      l != null &&
        (typeof l == "string" && (Zy(l) || Py(l))
          ? (l = parseFloat(l))
          : !Yb(l) && Ye.test(r) && (l = Bg(a, r)),
        this.setBaseTarget(a, ne(l) ? l.get() : l)),
      ne(l) ? l.get() : l
    );
  }
  setBaseTarget(a, r) {
    this.baseTarget[a] = r;
  }
  getBaseTarget(a) {
    const { initial: r } = this.props;
    let l;
    if (typeof r == "string" || typeof r == "object") {
      const d = lf(this.props, r, this.presenceContext?.custom);
      d && (l = d[a]);
    }
    if (r && l !== void 0) return l;
    const c = this.getBaseTargetFromProps(this.props, a);
    return c !== void 0 && !ne(c)
      ? c
      : this.initialValues[a] !== void 0 && l === void 0
        ? void 0
        : this.baseTarget[a];
  }
  on(a, r) {
    return this.events[a] || (this.events[a] = new Pc()), this.events[a].add(r);
  }
  notify(a, ...r) {
    this.events[a] && this.events[a].notify(...r);
  }
  scheduleRenderMicrotask() {
    uf.render(this.render);
  }
}
class Pg extends Kb {
  constructor() {
    super(...arguments), (this.KeyframeResolver = bb);
  }
  sortInstanceNodePosition(a, r) {
    return a.compareDocumentPosition(r) & 2 ? 1 : -1;
  }
  getBaseTargetFromProps(a, r) {
    const l = a.style;
    return l ? l[r] : void 0;
  }
  removeValueFromRenderState(a, { vars: r, style: l }) {
    delete r[a], delete l[a];
  }
  handleChildMotionValue() {
    this.childSubscription &&
      (this.childSubscription(), delete this.childSubscription);
    const { children: a } = this.props;
    ne(a) &&
      (this.childSubscription = a.on("change", (r) => {
        this.current && (this.current.textContent = `${r}`);
      }));
  }
}
class kn {
  constructor(a) {
    (this.isMounted = !1), (this.node = a);
  }
  update() {}
}
function Qg({ top: i, left: a, right: r, bottom: l }) {
  return { x: { min: a, max: r }, y: { min: i, max: l } };
}
function Pb({ x: i, y: a }) {
  return { top: a.min, right: i.max, bottom: a.max, left: i.min };
}
function Qb(i, a) {
  if (!a) return i;
  const r = a({ x: i.left, y: i.top }),
    l = a({ x: i.right, y: i.bottom });
  return { top: r.y, left: r.x, bottom: l.y, right: l.x };
}
function uc(i) {
  return i === void 0 || i === 1;
}
function zc({ scale: i, scaleX: a, scaleY: r }) {
  return !uc(i) || !uc(a) || !uc(r);
}
function ci(i) {
  return (
    zc(i) ||
    Jg(i) ||
    i.z ||
    i.rotate ||
    i.rotateX ||
    i.rotateY ||
    i.skewX ||
    i.skewY
  );
}
function Jg(i) {
  return Zp(i.x) || Zp(i.y);
}
function Zp(i) {
  return i && i !== "0%";
}
function xr(i, a, r) {
  const l = i - r,
    c = a * l;
  return r + c;
}
function Kp(i, a, r, l, c) {
  return c !== void 0 && (i = xr(i, c, l)), xr(i, r, l) + a;
}
function Uc(i, a = 0, r = 1, l, c) {
  (i.min = Kp(i.min, a, r, l, c)), (i.max = Kp(i.max, a, r, l, c));
}
function Fg(i, { x: a, y: r }) {
  Uc(i.x, a.translate, a.scale, a.originPoint),
    Uc(i.y, r.translate, r.scale, r.originPoint);
}
const Pp = 0.999999999999,
  Qp = 1.0000000000001;
function Jb(i, a, r, l = !1) {
  const c = r.length;
  if (!c) return;
  a.x = a.y = 1;
  let d, f;
  for (let m = 0; m < c; m++) {
    (d = r[m]), (f = d.projectionDelta);
    const { visualElement: y } = d.options;
    (y && y.props.style && y.props.style.display === "contents") ||
      (l &&
        d.options.layoutScroll &&
        d.scroll &&
        d !== d.root &&
        (Je(i.x, -d.scroll.offset.x), Je(i.y, -d.scroll.offset.y)),
      f && ((a.x *= f.x.scale), (a.y *= f.y.scale), Fg(i, f)),
      l && ci(d.latestValues) && ur(i, d.latestValues, d.layout?.layoutBox));
  }
  a.x < Qp && a.x > Pp && (a.x = 1), a.y < Qp && a.y > Pp && (a.y = 1);
}
function Je(i, a) {
  (i.min += a), (i.max += a);
}
function Jp(i, a, r, l, c = 0.5) {
  const d = Ot(i.min, i.max, c);
  Uc(i, a, r, d, l);
}
function Fp(i, a) {
  return typeof i == "string" ? (parseFloat(i) / 100) * (a.max - a.min) : i;
}
function ur(i, a, r) {
  const l = r ?? i;
  Jp(i.x, Fp(a.x, l.x), a.scaleX, a.scale, a.originX),
    Jp(i.y, Fp(a.y, l.y), a.scaleY, a.scale, a.originY);
}
function $g(i, a) {
  return Qg(Qb(i.getBoundingClientRect(), a));
}
function Fb(i, a, r) {
  const l = $g(i, r),
    { scroll: c } = a;
  return c && (Je(l.x, c.offset.x), Je(l.y, c.offset.y)), l;
}
const $b = {
    x: "translateX",
    y: "translateY",
    z: "translateZ",
    transformPerspective: "perspective",
  },
  Wb = ua.length;
function Ib(i, a, r) {
  let l = "",
    c = !0;
  for (let f = 0; f < Wb; f++) {
    const m = ua[f],
      y = i[m];
    if (y === void 0) continue;
    let p = !0;
    if (typeof y == "number") p = y === (m.startsWith("scale") ? 1 : 0);
    else {
      const g = parseFloat(y);
      p = m.startsWith("scale") ? g === 1 : g === 0;
    }
    if (!p || r) {
      const g = Lc(y, gr[m]);
      if (!p) {
        c = !1;
        const x = $b[m] || m;
        l += `${x}(${g}) `;
      }
      r && (a[m] = g);
    }
  }
  const d = i.pathRotation;
  return (
    d && ((c = !1), (l += `rotate(${Lc(d, gr.pathRotation)}) `)),
    (l = l.trim()),
    r ? (l = r(a, c ? "" : l)) : c && (l = "none"),
    l
  );
}
function pf(i, a, r) {
  const { style: l, vars: c, transformOrigin: d } = i;
  let f = !1,
    m = !1;
  for (const y in a) {
    const p = a[y];
    if (ca.has(y)) {
      f = !0;
      continue;
    } else if (og(y)) {
      c[y] = p;
      continue;
    } else {
      const g = Lc(p, gr[y]);
      y.startsWith("origin") ? ((m = !0), (d[y] = g)) : (l[y] = g);
    }
  }
  if (
    (a.transform ||
      (f || r
        ? (l.transform = Ib(a, i.transform, r))
        : l.transform && (l.transform = "none")),
    m)
  ) {
    const { originX: y = "50%", originY: p = "50%", originZ: g = 0 } = d;
    l.transformOrigin = `${y} ${p} ${g}`;
  }
}
function Wg(i, { style: a, vars: r }, l, c) {
  const d = i.style;
  let f;
  for (f in a) d[f] = a[f];
  c?.applyProjectionStyles(d, l);
  for (f in r) d.setProperty(f, r[f]);
}
function $p(i, a) {
  return a.max === a.min ? 0 : (i / (a.max - a.min)) * 100;
}
const hs = {
    correct: (i, a) => {
      if (!a.target) return i;
      if (typeof i == "string")
        if ($.test(i)) i = parseFloat(i);
        else return i;
      const r = $p(i, a.target.x),
        l = $p(i, a.target.y);
      return `${r}% ${l}%`;
    },
  },
  tT = {
    correct: (i, { treeScale: a, projectionDelta: r }) => {
      const l = i,
        c = Ye.parse(i);
      if (c.length > 5) return l;
      const d = Ye.createTransformer(i),
        f = typeof c[0] != "number" ? 1 : 0,
        m = r.x.scale * a.x,
        y = r.y.scale * a.y;
      (c[0 + f] /= m), (c[1 + f] /= y);
      const p = Ot(m, y, 0.5);
      return (
        typeof c[2 + f] == "number" && (c[2 + f] /= p),
        typeof c[3 + f] == "number" && (c[3 + f] /= p),
        d(c)
      );
    },
  },
  Bc = {
    borderRadius: { ...hs, applyTo: [...of] },
    borderTopLeftRadius: hs,
    borderTopRightRadius: hs,
    borderBottomLeftRadius: hs,
    borderBottomRightRadius: hs,
    boxShadow: tT,
  };
function Ig(i, { layout: a, layoutId: r }) {
  return (
    ca.has(i) ||
    i.startsWith("origin") ||
    ((a || r !== void 0) && (!!Bc[i] || i === "opacity"))
  );
}
function yf(i, a, r) {
  const l = i.style,
    c = a?.style,
    d = {};
  if (!l) return d;
  for (const f in l)
    (ne(l[f]) ||
      (c && ne(c[f])) ||
      Ig(f, i) ||
      r?.getValue(f)?.liveStyle !== void 0) &&
      (d[f] = l[f]);
  return d;
}
function eT(i) {
  return window.getComputedStyle(i);
}
class nT extends Pg {
  constructor() {
    super(...arguments), (this.type = "html"), (this.renderInstance = Wg);
  }
  mount(a) {
    Rr(!!a.style), super.mount(a);
  }
  readValueFromInstance(a, r) {
    if (ca.has(r)) return this.projection?.isProjecting ? Ac(r) : Ex(a, r);
    {
      const l = eT(a),
        c = (og(r) ? l.getPropertyValue(r) : l[r]) || 0;
      return typeof c == "string" ? c.trim() : c;
    }
  }
  measureInstanceViewportBox(a, { transformPagePoint: r }) {
    return $g(a, r);
  }
  build(a, r, l) {
    pf(a, r, l.transformTemplate);
  }
  scrapeMotionValuesFromProps(a, r, l) {
    return yf(a, r, l);
  }
}
const iT = { offset: "stroke-dashoffset", array: "stroke-dasharray" },
  aT = { offset: "strokeDashoffset", array: "strokeDasharray" };
function sT(i, a, r = 1, l = 0, c = !0) {
  i.pathLength = 1;
  const d = c ? iT : aT;
  (i[d.offset] = `${-l}`), (i[d.array] = `${a} ${r}`);
}
const lT = ["offsetDistance", "offsetPath", "offsetRotate", "offsetAnchor"];
function t0(
  i,
  {
    attrX: a,
    attrY: r,
    attrScale: l,
    pathLength: c,
    pathSpacing: d = 1,
    pathOffset: f = 0,
    ...m
  },
  y,
  p,
  g,
) {
  if ((pf(i, m, p), y)) {
    i.style.viewBox && (i.attrs.viewBox = i.style.viewBox);
    return;
  }
  (i.attrs = i.style), (i.style = {});
  const { attrs: x, style: b } = i;
  x.transform && ((b.transform = x.transform), delete x.transform),
    (b.transform || x.transformOrigin) &&
      ((b.transformOrigin = x.transformOrigin ?? "50% 50%"),
      delete x.transformOrigin),
    b.transform &&
      ((b.transformBox = g?.transformBox ?? "fill-box"), delete x.transformBox);
  for (const j of lT) x[j] !== void 0 && ((b[j] = x[j]), delete x[j]);
  a !== void 0 && (x.x = a),
    r !== void 0 && (x.y = r),
    l !== void 0 && (x.scale = l),
    c !== void 0 && sT(x, c, d, f, !1);
}
const e0 = new Set([
    "baseFrequency",
    "diffuseConstant",
    "kernelMatrix",
    "kernelUnitLength",
    "keySplines",
    "keyTimes",
    "limitingConeAngle",
    "markerHeight",
    "markerWidth",
    "numOctaves",
    "targetX",
    "targetY",
    "surfaceScale",
    "specularConstant",
    "specularExponent",
    "stdDeviation",
    "tableValues",
    "viewBox",
    "gradientTransform",
    "pathLength",
    "startOffset",
    "textLength",
    "lengthAdjust",
  ]),
  n0 = (i) => typeof i == "string" && i.toLowerCase() === "svg";
function rT(i, a, r, l) {
  Wg(i, a, void 0, l);
  for (const c in a.attrs) i.setAttribute(e0.has(c) ? c : rf(c), a.attrs[c]);
}
function i0(i, a, r) {
  const l = yf(i, a, r);
  for (const c in i)
    if (ne(i[c]) || ne(a[c])) {
      const d =
        ua.indexOf(c) !== -1
          ? "attr" + c.charAt(0).toUpperCase() + c.substring(1)
          : c;
      l[d] = i[c];
    }
  return l;
}
class oT extends Pg {
  constructor() {
    super(...arguments),
      (this.type = "svg"),
      (this.isSVGTag = !1),
      (this.measureInstanceViewportBox = Zt);
  }
  getBaseTargetFromProps(a, r) {
    return a[r];
  }
  readValueFromInstance(a, r) {
    if (ca.has(r)) {
      const l = Ug(r);
      return (l && l.default) || 0;
    }
    return (r = e0.has(r) ? r : rf(r)), a.getAttribute(r);
  }
  scrapeMotionValuesFromProps(a, r, l) {
    return i0(a, r, l);
  }
  build(a, r, l) {
    t0(a, r, this.isSVGTag, l.transformTemplate, l.style);
  }
  renderInstance(a, r, l, c) {
    rT(a, r, l, c);
  }
  mount(a) {
    (this.isSVGTag = n0(a.tagName)), super.mount(a);
  }
}
const uT = hf.length;
function a0(i) {
  if (!i) return;
  if (!i.isControllingVariants) {
    const r = i.parent ? a0(i.parent) || {} : {};
    return i.props.initial !== void 0 && (r.initial = i.props.initial), r;
  }
  const a = {};
  for (let r = 0; r < uT; r++) {
    const l = hf[r],
      c = i.props[l];
    (Ts(c) || c === !1) && (a[l] = c);
  }
  return a;
}
function s0(i, a) {
  if (!Array.isArray(a)) return !1;
  const r = a.length;
  if (r !== i.length) return !1;
  for (let l = 0; l < r; l++) if (a[l] !== i[l]) return !1;
  return !0;
}
const cT = [...df].reverse(),
  fT = df.length;
function dT(i) {
  return (a) =>
    Promise.all(a.map(({ animation: r, options: l }) => cb(i, r, l)));
}
function hT(i) {
  let a = dT(i),
    r = Wp(),
    l = !0,
    c = !1;
  const d = (p) => (g, x) => {
    const b = yi(i, x, p === "exit" ? i.presenceContext?.custom : void 0);
    if (b) {
      const { transition: j, transitionEnd: A, ...R } = b;
      g = { ...g, ...R, ...A };
    }
    return g;
  };
  function f(p) {
    a = p(i);
  }
  function m(p) {
    const { props: g } = i,
      x = a0(i.parent) || {},
      b = [],
      j = new Set();
    let A = {},
      R = 1 / 0;
    for (let L = 0; L < fT; L++) {
      const _ = cT[L],
        H = r[_],
        X = g[_] !== void 0 ? g[_] : x[_],
        k = Ts(X),
        tt = _ === p ? H.isActive : null;
      tt === !1 && (R = L);
      let et = X === x[_] && X !== g[_] && k;
      if (
        (et && (l || c) && i.manuallyAnimateOnMount && (et = !1),
        (H.protectedKeys = { ...A }),
        (!H.isActive && tt === null) ||
          (!X && !H.prevProp) ||
          Or(X) ||
          typeof X == "boolean")
      )
        continue;
      if (_ === "exit" && H.isActive && tt !== !0) {
        H.prevResolvedValues && (A = { ...A, ...H.prevResolvedValues });
        continue;
      }
      const P = mT(H.prevProp, X);
      let lt = P || (_ === p && H.isActive && !et && k) || (L > R && k),
        W = !1;
      const mt = Array.isArray(X) ? X : [X];
      let pt = mt.reduce(d(_), {});
      tt === !1 && (pt = {});
      const { prevResolvedValues: $t = {} } = H,
        Kt = { ...$t, ...pt },
        Ct = (J) => {
          (lt = !0),
            j.has(J) && ((W = !0), j.delete(J)),
            (H.needsAnimating[J] = !0);
          const ut = i.getValue(J);
          ut && (ut.liveStyle = !1);
        };
      for (const J in Kt) {
        const ut = pt[J],
          E = $t[J];
        if (A.hasOwnProperty(J)) continue;
        let q = !1;
        jc(ut) && jc(E) ? (q = !s0(ut, E) || P) : (q = ut !== E),
          q
            ? ut != null
              ? Ct(J)
              : j.add(J)
            : ut !== void 0 && j.has(J)
              ? Ct(J)
              : (H.protectedKeys[J] = !0);
      }
      (H.prevProp = X),
        (H.prevResolvedValues = pt),
        H.isActive && (A = { ...A, ...pt }),
        (l || c) && i.blockInitialAnimation && (lt = !1);
      const z = et && P;
      lt &&
        (!z || W) &&
        b.push(
          ...mt.map((J) => {
            const ut = { type: _ };
            if (
              typeof J == "string" &&
              (l || c) &&
              !z &&
              i.manuallyAnimateOnMount &&
              i.parent
            ) {
              const { parent: E } = i,
                q = yi(E, J);
              if (E.enteringChildren && q) {
                const { delayChildren: Q } = q.transition || {};
                ut.delay = Og(E.enteringChildren, i, Q);
              }
            }
            return { animation: J, options: ut };
          }),
        );
    }
    if (j.size) {
      const L = {};
      if (typeof g.initial != "boolean") {
        const _ = yi(i, Array.isArray(g.initial) ? g.initial[0] : g.initial);
        _ && _.transition && (L.transition = _.transition);
      }
      j.forEach((_) => {
        const H = i.getBaseTarget(_),
          X = i.getValue(_);
        X && (X.liveStyle = !0), (L[_] = H ?? null);
      }),
        b.push({ animation: L });
    }
    let V = !!b.length;
    return (
      l &&
        (g.initial === !1 || g.initial === g.animate) &&
        !i.manuallyAnimateOnMount &&
        (V = !1),
      (l = !1),
      (c = !1),
      V ? a(b) : Promise.resolve()
    );
  }
  function y(p, g) {
    if (r[p].isActive === g) return Promise.resolve();
    i.variantChildren?.forEach((b) => b.animationState?.setActive(p, g)),
      (r[p].isActive = g);
    const x = m(p);
    for (const b in r) r[b].protectedKeys = {};
    return x;
  }
  return {
    animateChanges: m,
    setActive: y,
    setAnimateFunction: f,
    getState: () => r,
    reset: () => {
      (r = Wp()), (c = !0);
    },
  };
}
function mT(i, a) {
  return typeof a == "string" ? a !== i : Array.isArray(a) ? !s0(a, i) : !1;
}
function ui(i = !1) {
  return {
    isActive: i,
    protectedKeys: {},
    needsAnimating: {},
    prevResolvedValues: {},
  };
}
function Wp() {
  return {
    animate: ui(!0),
    whileInView: ui(),
    whileHover: ui(),
    whileTap: ui(),
    whileDrag: ui(),
    whileFocus: ui(),
    exit: ui(),
  };
}
function Hc(i, a) {
  (i.min = a.min), (i.max = a.max);
}
function He(i, a) {
  Hc(i.x, a.x), Hc(i.y, a.y);
}
function Ip(i, a) {
  (i.translate = a.translate),
    (i.scale = a.scale),
    (i.originPoint = a.originPoint),
    (i.origin = a.origin);
}
const l0 = 1e-4,
  pT = 1 - l0,
  yT = 1 + l0,
  r0 = 0.01,
  gT = 0 - r0,
  vT = 0 + r0;
function oe(i) {
  return i.max - i.min;
}
function ST(i, a, r) {
  return Math.abs(i - a) <= r;
}
function ty(i, a, r, l = 0.5) {
  (i.origin = l),
    (i.originPoint = Ot(a.min, a.max, i.origin)),
    (i.scale = oe(r) / oe(a)),
    (i.translate = Ot(r.min, r.max, i.origin) - i.originPoint),
    ((i.scale >= pT && i.scale <= yT) || isNaN(i.scale)) && (i.scale = 1),
    ((i.translate >= gT && i.translate <= vT) || isNaN(i.translate)) &&
      (i.translate = 0);
}
function gs(i, a, r, l) {
  ty(i.x, a.x, r.x, l ? l.originX : void 0),
    ty(i.y, a.y, r.y, l ? l.originY : void 0);
}
function ey(i, a, r, l = 0) {
  const c = l ? Ot(r.min, r.max, l) : r.min;
  (i.min = c + a.min), (i.max = i.min + oe(a));
}
function xT(i, a, r, l) {
  ey(i.x, a.x, r.x, l?.x), ey(i.y, a.y, r.y, l?.y);
}
function ny(i, a, r, l = 0) {
  const c = l ? Ot(r.min, r.max, l) : r.min;
  (i.min = a.min - c), (i.max = i.min + oe(a));
}
function br(i, a, r, l) {
  ny(i.x, a.x, r.x, l?.x), ny(i.y, a.y, r.y, l?.y);
}
function iy(i, a, r, l, c) {
  return (
    (i -= a), (i = xr(i, 1 / r, l)), c !== void 0 && (i = xr(i, 1 / c, l)), i
  );
}
function bT(i, a = 0, r = 1, l = 0.5, c, d = i, f = i) {
  if (
    (Fe.test(a) &&
      ((a = parseFloat(a)), (a = Ot(f.min, f.max, a / 100) - f.min)),
    typeof a != "number")
  )
    return;
  let m = Ot(d.min, d.max, l);
  i === d && (m -= a),
    (i.min = iy(i.min, a, r, m, c)),
    (i.max = iy(i.max, a, r, m, c));
}
function ay(i, a, [r, l, c], d, f) {
  bT(i, a[r], a[l], a[c], a.scale, d, f);
}
const TT = ["x", "scaleX", "originX"],
  ET = ["y", "scaleY", "originY"];
function sy(i, a, r, l) {
  ay(i.x, a, TT, r ? r.x : void 0, l ? l.x : void 0),
    ay(i.y, a, ET, r ? r.y : void 0, l ? l.y : void 0);
}
function ly(i) {
  return i.translate === 0 && i.scale === 1;
}
function o0(i) {
  return ly(i.x) && ly(i.y);
}
function ry(i, a) {
  return i.min === a.min && i.max === a.max;
}
function AT(i, a) {
  return ry(i.x, a.x) && ry(i.y, a.y);
}
function oy(i, a) {
  return (
    Math.round(i.min) === Math.round(a.min) &&
    Math.round(i.max) === Math.round(a.max)
  );
}
function u0(i, a) {
  return oy(i.x, a.x) && oy(i.y, a.y);
}
function uy(i) {
  return oe(i.x) / oe(i.y);
}
function cy(i, a) {
  return (
    i.translate === a.translate &&
    i.scale === a.scale &&
    i.originPoint === a.originPoint
  );
}
function Qe(i) {
  return [i("x"), i("y")];
}
function MT(i, a, r) {
  let l = "";
  const c = i.x.translate / a.x,
    d = i.y.translate / a.y,
    f = r?.z || 0;
  if (
    ((c || d || f) && (l = `translate3d(${c}px, ${d}px, ${f}px) `),
    (a.x !== 1 || a.y !== 1) && (l += `scale(${1 / a.x}, ${1 / a.y}) `),
    r)
  ) {
    const {
      transformPerspective: p,
      rotate: g,
      pathRotation: x,
      rotateX: b,
      rotateY: j,
      skewX: A,
      skewY: R,
    } = r;
    p && (l = `perspective(${p}px) ${l}`),
      g && (l += `rotate(${g}deg) `),
      x && (l += `rotate(${x}deg) `),
      b && (l += `rotateX(${b}deg) `),
      j && (l += `rotateY(${j}deg) `),
      A && (l += `skewX(${A}deg) `),
      R && (l += `skewY(${R}deg) `);
  }
  const m = i.x.scale * a.x,
    y = i.y.scale * a.y;
  return (m !== 1 || y !== 1) && (l += `scale(${m}, ${y})`), l || "none";
}
const RT = of.length,
  fy = (i) => (typeof i == "string" ? parseFloat(i) : i),
  dy = (i) => typeof i == "number" || $.test(i);
function DT(i, a, r, l, c, d) {
  c
    ? ((i.opacity = Ot(0, r.opacity ?? 1, OT(l))),
      (i.opacityExit = Ot(a.opacity ?? 1, 0, CT(l))))
    : d && (i.opacity = Ot(a.opacity ?? 1, r.opacity ?? 1, l));
  for (let f = 0; f < RT; f++) {
    const m = of[f];
    let y = hy(a, m),
      p = hy(r, m);
    if (y === void 0 && p === void 0) continue;
    y || (y = 0),
      p || (p = 0),
      y === 0 || p === 0 || dy(y) === dy(p)
        ? ((i[m] = Math.max(Ot(fy(y), fy(p), l), 0)),
          (Fe.test(p) || Fe.test(y)) && (i[m] += "%"))
        : (i[m] = p);
  }
  (a.rotate || r.rotate) && (i.rotate = Ot(a.rotate || 0, r.rotate || 0, l));
}
function hy(i, a) {
  return i[a] !== void 0 ? i[a] : i.borderRadius;
}
const OT = c0(0, 0.5, ng),
  CT = c0(0.5, 0.95, Le);
function c0(i, a, r) {
  return (l) => (l < i ? 0 : l > a ? 1 : r(xs(i, a, l)));
}
function jT(i, a, r) {
  const l = ne(i) ? i : gi(i);
  return l.start(sf("", l, a, r)), l.animation;
}
function Es(i, a, r, l = { passive: !0 }) {
  return i.addEventListener(a, r, l), () => i.removeEventListener(a, r, l);
}
const NT = (i, a) => i.depth - a.depth;
class wT {
  constructor() {
    (this.children = []), (this.isDirty = !1);
  }
  add(a) {
    Kc(this.children, a), (this.isDirty = !0);
  }
  remove(a) {
    dr(this.children, a), (this.isDirty = !0);
  }
  forEach(a) {
    this.isDirty && this.children.sort(NT),
      (this.isDirty = !1),
      this.children.forEach(a);
  }
}
function VT(i, a) {
  const r = re.now(),
    l = ({ timestamp: c }) => {
      const d = c - r;
      d >= a && (pn(l), i(d - a));
    };
  return Et.setup(l, !0), () => pn(l);
}
function cr(i) {
  return ne(i) ? i.get() : i;
}
class _T {
  constructor() {
    this.members = [];
  }
  add(a) {
    Kc(this.members, a);
    for (let r = this.members.length - 1; r >= 0; r--) {
      const l = this.members[r];
      if (l === a || l === this.lead || l === this.prevLead) continue;
      const c = l.instance;
      (!c || c.isConnected === !1) &&
        !l.snapshot &&
        (dr(this.members, l), l.unmount());
    }
    a.scheduleRender();
  }
  remove(a) {
    if (
      (dr(this.members, a),
      a === this.prevLead && (this.prevLead = void 0),
      a === this.lead)
    ) {
      const r = this.members[this.members.length - 1];
      r && this.promote(r);
    }
  }
  relegate(a) {
    for (let r = this.members.indexOf(a) - 1; r >= 0; r--) {
      const l = this.members[r];
      if (l.isPresent !== !1 && l.instance?.isConnected !== !1)
        return this.promote(l), !0;
    }
    return !1;
  }
  promote(a, r) {
    const l = this.lead;
    if (a !== l && ((this.prevLead = l), (this.lead = a), a.show(), l)) {
      l.updateSnapshot(), a.scheduleRender();
      const { layoutDependency: c } = l.options,
        { layoutDependency: d } = a.options;
      (c === void 0 || c !== d) &&
        ((a.resumeFrom = l),
        r && (l.preserveOpacity = !0),
        l.snapshot &&
          ((a.snapshot = l.snapshot),
          (a.snapshot.latestValues = l.animationValues || l.latestValues)),
        a.root?.isUpdating && (a.isLayoutDirty = !0)),
        a.options.crossfade === !1 && l.hide();
    }
  }
  exitAnimationComplete() {
    this.members.forEach((a) => {
      a.options.onExitComplete?.(), a.resumingFrom?.options.onExitComplete?.();
    });
  }
  scheduleRender() {
    this.members.forEach((a) => a.instance && a.scheduleRender(!1));
  }
  removeLeadSnapshot() {
    this.lead?.snapshot && (this.lead.snapshot = void 0);
  }
}
const fr = { hasAnimatedSinceResize: !0, hasEverUpdated: !1 },
  cc = ["", "X", "Y", "Z"],
  LT = 1e3;
let zT = 0;
function fc(i, a, r, l) {
  const { latestValues: c } = a;
  c[i] && ((r[i] = c[i]), a.setStaticValue(i, 0), l && (l[i] = 0));
}
function f0(i) {
  if (((i.hasCheckedOptimisedAppear = !0), i.root === i)) return;
  const { visualElement: a } = i.options;
  if (!a) return;
  const r = Vg(a);
  if (window.MotionHasOptimisedAnimation(r, "transform")) {
    const { layout: c, layoutId: d } = i.options;
    window.MotionCancelOptimisedAnimation(r, "transform", Et, !(c || d));
  }
  const { parent: l } = i;
  l && !l.hasCheckedOptimisedAppear && f0(l);
}
function d0({
  attachResizeListener: i,
  defaultParent: a,
  measureScroll: r,
  checkIsScrollRoot: l,
  resetTransform: c,
}) {
  return class {
    constructor(f = {}, m = a?.()) {
      (this.id = zT++),
        (this.animationId = 0),
        (this.animationCommitId = 0),
        (this.children = new Set()),
        (this.options = {}),
        (this.isTreeAnimating = !1),
        (this.isAnimationBlocked = !1),
        (this.isLayoutDirty = !1),
        (this.isProjectionDirty = !1),
        (this.isSharedProjectionDirty = !1),
        (this.isTransformDirty = !1),
        (this.updateManuallyBlocked = !1),
        (this.updateBlockedByResize = !1),
        (this.isUpdating = !1),
        (this.isSVG = !1),
        (this.needsReset = !1),
        (this.shouldResetTransform = !1),
        (this.hasCheckedOptimisedAppear = !1),
        (this.treeScale = { x: 1, y: 1 }),
        (this.eventHandlers = new Map()),
        (this.hasTreeAnimated = !1),
        (this.layoutVersion = 0),
        (this.updateScheduled = !1),
        (this.scheduleUpdate = () => this.update()),
        (this.projectionUpdateScheduled = !1),
        (this.checkUpdateFailed = () => {
          this.isUpdating && ((this.isUpdating = !1), this.clearAllSnapshots());
        }),
        (this.updateProjection = () => {
          (this.projectionUpdateScheduled = !1),
            this.nodes.forEach(HT),
            this.nodes.forEach(ZT),
            this.nodes.forEach(KT),
            this.nodes.forEach(GT);
        }),
        (this.resolvedRelativeTargetAt = 0),
        (this.linkedParentVersion = 0),
        (this.hasProjected = !1),
        (this.isVisible = !0),
        (this.animationProgress = 0),
        (this.sharedNodes = new Map()),
        (this.latestValues = f),
        (this.root = m ? m.root || m : this),
        (this.path = m ? [...m.path, m] : []),
        (this.parent = m),
        (this.depth = m ? m.depth + 1 : 0);
      for (let y = 0; y < this.path.length; y++)
        this.path[y].shouldResetTransform = !0;
      this.root === this && (this.nodes = new wT());
    }
    addEventListener(f, m) {
      return (
        this.eventHandlers.has(f) || this.eventHandlers.set(f, new Pc()),
        this.eventHandlers.get(f).add(m)
      );
    }
    notifyListeners(f, ...m) {
      const y = this.eventHandlers.get(f);
      y && y.notify(...m);
    }
    hasListeners(f) {
      return this.eventHandlers.has(f);
    }
    mount(f) {
      if (this.instance) return;
      (this.isSVG = ff(f) && !Hb(f)), (this.instance = f);
      const { layoutId: m, layout: y, visualElement: p } = this.options;
      if (
        (p && !p.current && p.mount(f),
        this.root.nodes.add(this),
        this.parent && this.parent.children.add(this),
        this.root.hasTreeAnimated && (y || m) && (this.isLayoutDirty = !0),
        i)
      ) {
        let g,
          x = 0;
        const b = () => (this.root.updateBlockedByResize = !1);
        Et.read(() => {
          x = window.innerWidth;
        }),
          i(f, () => {
            const j = window.innerWidth;
            j !== x &&
              ((x = j),
              (this.root.updateBlockedByResize = !0),
              g && g(),
              (g = VT(b, 250)),
              fr.hasAnimatedSinceResize &&
                ((fr.hasAnimatedSinceResize = !1), this.nodes.forEach(yy)));
          });
      }
      m && this.root.registerSharedNode(m, this),
        this.options.animate !== !1 &&
          p &&
          (m || y) &&
          this.addEventListener(
            "didUpdate",
            ({
              delta: g,
              hasLayoutChanged: x,
              hasRelativeLayoutChanged: b,
              layout: j,
            }) => {
              if (this.isTreeAnimationBlocked()) {
                (this.target = void 0), (this.relativeTarget = void 0);
                return;
              }
              const A =
                  this.options.transition || p.getDefaultTransition() || $T,
                { onLayoutAnimationStart: R, onLayoutAnimationComplete: V } =
                  p.getProps(),
                L = !this.targetLayout || !u0(this.targetLayout, j),
                _ = !x && b;
              if (
                this.options.layoutRoot ||
                this.resumeFrom ||
                _ ||
                (x && (L || !this.currentAnimation))
              ) {
                this.resumeFrom &&
                  ((this.resumingFrom = this.resumeFrom),
                  (this.resumingFrom.resumingFrom = void 0));
                const H = { ...af(A, "layout"), onPlay: R, onComplete: V };
                (p.shouldReduceMotion || this.options.layoutRoot) &&
                  ((H.delay = 0), (H.type = !1)),
                  this.startAnimation(H),
                  this.setAnimationOrigin(g, _, H.path);
              } else
                x || yy(this),
                  this.isLead() &&
                    this.options.onExitComplete &&
                    this.options.onExitComplete();
              this.targetLayout = j;
            },
          );
    }
    unmount() {
      this.options.layoutId && this.willUpdate(), this.root.nodes.remove(this);
      const f = this.getStack();
      f && f.remove(this),
        this.parent && this.parent.children.delete(this),
        (this.instance = void 0),
        this.eventHandlers.clear(),
        pn(this.updateProjection);
    }
    blockUpdate() {
      this.updateManuallyBlocked = !0;
    }
    unblockUpdate() {
      this.updateManuallyBlocked = !1;
    }
    isUpdateBlocked() {
      return this.updateManuallyBlocked || this.updateBlockedByResize;
    }
    isTreeAnimationBlocked() {
      return (
        this.isAnimationBlocked ||
        (this.parent && this.parent.isTreeAnimationBlocked()) ||
        !1
      );
    }
    startUpdate() {
      this.isUpdateBlocked() ||
        ((this.isUpdating = !0),
        this.nodes && this.nodes.forEach(PT),
        this.animationId++);
    }
    getTransformTemplate() {
      const { visualElement: f } = this.options;
      return f && f.getProps().transformTemplate;
    }
    willUpdate(f = !0) {
      if (((this.root.hasTreeAnimated = !0), this.root.isUpdateBlocked())) {
        this.options.onExitComplete && this.options.onExitComplete();
        return;
      }
      if (
        (window.MotionCancelOptimisedAnimation &&
          !this.hasCheckedOptimisedAppear &&
          f0(this),
        !this.root.isUpdating && this.root.startUpdate(),
        this.isLayoutDirty)
      )
        return;
      this.isLayoutDirty = !0;
      for (let g = 0; g < this.path.length; g++) {
        const x = this.path[g];
        (x.shouldResetTransform = !0),
          (typeof x.latestValues.x == "string" ||
            typeof x.latestValues.y == "string") &&
            (x.isLayoutDirty = !0),
          x.updateScroll("snapshot"),
          x.options.layoutRoot && x.willUpdate(!1);
      }
      const { layoutId: m, layout: y } = this.options;
      if (m === void 0 && !y) return;
      const p = this.getTransformTemplate();
      (this.prevTransformTemplateValue = p ? p(this.latestValues, "") : void 0),
        this.updateSnapshot(),
        f && this.notifyListeners("willUpdate");
    }
    update() {
      if (((this.updateScheduled = !1), this.isUpdateBlocked())) {
        const y = this.updateBlockedByResize;
        this.unblockUpdate(),
          (this.updateBlockedByResize = !1),
          this.clearAllSnapshots(),
          y && this.nodes.forEach(qT),
          this.nodes.forEach(my);
        return;
      }
      if (this.animationId <= this.animationCommitId) {
        this.nodes.forEach(py);
        return;
      }
      (this.animationCommitId = this.animationId),
        this.isUpdating
          ? ((this.isUpdating = !1),
            this.nodes.forEach(XT),
            this.nodes.forEach(kT),
            this.nodes.forEach(UT),
            this.nodes.forEach(BT))
          : this.nodes.forEach(py),
        this.clearAllSnapshots();
      const m = re.now();
      (ee.delta = $e(0, 1e3 / 60, m - ee.timestamp)),
        (ee.timestamp = m),
        (ee.isProcessing = !0),
        nc.update.process(ee),
        nc.preRender.process(ee),
        nc.render.process(ee),
        (ee.isProcessing = !1);
    }
    didUpdate() {
      this.updateScheduled ||
        ((this.updateScheduled = !0), uf.read(this.scheduleUpdate));
    }
    clearAllSnapshots() {
      this.nodes.forEach(YT), this.sharedNodes.forEach(QT);
    }
    scheduleUpdateProjection() {
      this.projectionUpdateScheduled ||
        ((this.projectionUpdateScheduled = !0),
        Et.preRender(this.updateProjection, !1, !0));
    }
    scheduleCheckAfterUnmount() {
      Et.postRender(() => {
        this.isLayoutDirty
          ? this.root.didUpdate()
          : this.root.checkUpdateFailed();
      });
    }
    updateSnapshot() {
      this.snapshot ||
        !this.instance ||
        ((this.snapshot = this.measure()),
        this.snapshot &&
          !oe(this.snapshot.measuredBox.x) &&
          !oe(this.snapshot.measuredBox.y) &&
          (this.snapshot = void 0));
    }
    updateLayout() {
      if (
        !this.instance ||
        (this.updateScroll(),
        !(this.options.alwaysMeasureLayout && this.isLead()) &&
          !this.isLayoutDirty)
      )
        return;
      if (this.resumeFrom && !this.resumeFrom.instance)
        for (let y = 0; y < this.path.length; y++) this.path[y].updateScroll();
      const f = this.layout;
      (this.layout = this.measure(!1)),
        this.layoutVersion++,
        this.layoutCorrected || (this.layoutCorrected = Zt()),
        (this.isLayoutDirty = !1),
        (this.projectionDelta = void 0),
        this.notifyListeners("measure", this.layout.layoutBox);
      const { visualElement: m } = this.options;
      m &&
        m.notify(
          "LayoutMeasure",
          this.layout.layoutBox,
          f ? f.layoutBox : void 0,
        );
    }
    updateScroll(f = "measure") {
      let m = !!(this.options.layoutScroll && this.instance);
      if (
        (this.scroll &&
          this.scroll.animationId === this.root.animationId &&
          this.scroll.phase === f &&
          (m = !1),
        m && this.instance)
      ) {
        const y = l(this.instance);
        this.scroll = {
          animationId: this.root.animationId,
          phase: f,
          isRoot: y,
          offset: r(this.instance),
          wasRoot: this.scroll ? this.scroll.isRoot : y,
        };
      }
    }
    resetTransform() {
      if (!c) return;
      const f =
          this.isLayoutDirty ||
          this.shouldResetTransform ||
          this.options.alwaysMeasureLayout,
        m = this.projectionDelta && !o0(this.projectionDelta),
        y = this.getTransformTemplate(),
        p = y ? y(this.latestValues, "") : void 0,
        g = p !== this.prevTransformTemplateValue;
      f &&
        this.instance &&
        (m || ci(this.latestValues) || g) &&
        (c(this.instance, p),
        (this.shouldResetTransform = !1),
        this.scheduleRender());
    }
    measure(f = !0) {
      const m = this.measurePageBox();
      let y = this.removeElementScroll(m);
      return (
        f && (y = this.removeTransform(y)),
        WT(y),
        {
          animationId: this.root.animationId,
          measuredBox: m,
          layoutBox: y,
          latestValues: {},
          source: this.id,
        }
      );
    }
    measurePageBox() {
      const { visualElement: f } = this.options;
      if (!f) return Zt();
      const m = f.measureViewportBox();
      if (!(this.scroll?.wasRoot || this.path.some(IT))) {
        const { scroll: p } = this.root;
        p && (Je(m.x, p.offset.x), Je(m.y, p.offset.y));
      }
      return m;
    }
    removeElementScroll(f) {
      const m = Zt();
      if ((He(m, f), this.scroll?.wasRoot)) return m;
      for (let y = 0; y < this.path.length; y++) {
        const p = this.path[y],
          { scroll: g, options: x } = p;
        p !== this.root &&
          g &&
          x.layoutScroll &&
          (g.wasRoot && He(m, f), Je(m.x, g.offset.x), Je(m.y, g.offset.y));
      }
      return m;
    }
    applyTransform(f, m = !1, y) {
      const p = y || Zt();
      He(p, f);
      for (let g = 0; g < this.path.length; g++) {
        const x = this.path[g];
        !m &&
          x.options.layoutScroll &&
          x.scroll &&
          x !== x.root &&
          (Je(p.x, -x.scroll.offset.x), Je(p.y, -x.scroll.offset.y)),
          ci(x.latestValues) && ur(p, x.latestValues, x.layout?.layoutBox);
      }
      return (
        ci(this.latestValues) &&
          ur(p, this.latestValues, this.layout?.layoutBox),
        p
      );
    }
    removeTransform(f) {
      const m = Zt();
      He(m, f);
      for (let y = 0; y < this.path.length; y++) {
        const p = this.path[y];
        if (!ci(p.latestValues)) continue;
        let g;
        p.instance &&
          (zc(p.latestValues) && p.updateSnapshot(),
          (g = Zt()),
          He(g, p.measurePageBox())),
          sy(m, p.latestValues, p.snapshot?.layoutBox, g);
      }
      return ci(this.latestValues) && sy(m, this.latestValues), m;
    }
    setTargetDelta(f) {
      (this.targetDelta = f),
        this.root.scheduleUpdateProjection(),
        (this.isProjectionDirty = !0);
    }
    setOptions(f) {
      this.options = {
        ...this.options,
        ...f,
        crossfade: f.crossfade !== void 0 ? f.crossfade : !0,
      };
    }
    clearMeasurements() {
      (this.scroll = void 0),
        (this.layout = void 0),
        (this.snapshot = void 0),
        (this.prevTransformTemplateValue = void 0),
        (this.targetDelta = void 0),
        (this.target = void 0),
        (this.isLayoutDirty = !1);
    }
    forceRelativeParentToResolveTarget() {
      this.relativeParent &&
        this.relativeParent.resolvedRelativeTargetAt !== ee.timestamp &&
        this.relativeParent.resolveTargetDelta(!0);
    }
    resolveTargetDelta(f = !1) {
      const m = this.getLead();
      this.isProjectionDirty || (this.isProjectionDirty = m.isProjectionDirty),
        this.isTransformDirty || (this.isTransformDirty = m.isTransformDirty),
        this.isSharedProjectionDirty ||
          (this.isSharedProjectionDirty = m.isSharedProjectionDirty);
      const y = !!this.resumingFrom || this !== m;
      if (
        !(
          f ||
          (y && this.isSharedProjectionDirty) ||
          this.isProjectionDirty ||
          this.parent?.isProjectionDirty ||
          this.attemptToResolveRelativeTarget ||
          this.root.updateBlockedByResize
        )
      )
        return;
      const { layout: g, layoutId: x } = this.options;
      if (!this.layout || !(g || x)) return;
      this.resolvedRelativeTargetAt = ee.timestamp;
      const b = this.getClosestProjectingParent();
      b &&
        this.linkedParentVersion !== b.layoutVersion &&
        !b.options.layoutRoot &&
        this.removeRelativeTarget(),
        !this.targetDelta &&
          !this.relativeTarget &&
          (this.options.layoutAnchor !== !1 && b && b.layout
            ? this.createRelativeTarget(
                b,
                this.layout.layoutBox,
                b.layout.layoutBox,
              )
            : this.removeRelativeTarget()),
        !(!this.relativeTarget && !this.targetDelta) &&
          (this.target ||
            ((this.target = Zt()), (this.targetWithTransforms = Zt())),
          this.relativeTarget &&
          this.relativeTargetOrigin &&
          this.relativeParent &&
          this.relativeParent.target
            ? (this.forceRelativeParentToResolveTarget(),
              xT(
                this.target,
                this.relativeTarget,
                this.relativeParent.target,
                this.options.layoutAnchor || void 0,
              ))
            : this.targetDelta
              ? (this.resumingFrom
                  ? this.applyTransform(this.layout.layoutBox, !1, this.target)
                  : He(this.target, this.layout.layoutBox),
                Fg(this.target, this.targetDelta))
              : He(this.target, this.layout.layoutBox),
          this.attemptToResolveRelativeTarget &&
            ((this.attemptToResolveRelativeTarget = !1),
            this.options.layoutAnchor !== !1 &&
            b &&
            !!b.resumingFrom == !!this.resumingFrom &&
            !b.options.layoutScroll &&
            b.target &&
            this.animationProgress !== 1
              ? this.createRelativeTarget(b, this.target, b.target)
              : (this.relativeParent = this.relativeTarget = void 0)));
    }
    getClosestProjectingParent() {
      if (
        !(
          !this.parent ||
          zc(this.parent.latestValues) ||
          Jg(this.parent.latestValues)
        )
      )
        return this.parent.isProjecting()
          ? this.parent
          : this.parent.getClosestProjectingParent();
    }
    isProjecting() {
      return !!(
        (this.relativeTarget || this.targetDelta || this.options.layoutRoot) &&
        this.layout
      );
    }
    createRelativeTarget(f, m, y) {
      (this.relativeParent = f),
        (this.linkedParentVersion = f.layoutVersion),
        this.forceRelativeParentToResolveTarget(),
        (this.relativeTarget = Zt()),
        (this.relativeTargetOrigin = Zt()),
        br(
          this.relativeTargetOrigin,
          m,
          y,
          this.options.layoutAnchor || void 0,
        ),
        He(this.relativeTarget, this.relativeTargetOrigin);
    }
    removeRelativeTarget() {
      this.relativeParent = this.relativeTarget = void 0;
    }
    calcProjection() {
      const f = this.getLead(),
        m = !!this.resumingFrom || this !== f;
      let y = !0;
      if (
        ((this.isProjectionDirty || this.parent?.isProjectionDirty) && (y = !1),
        m &&
          (this.isSharedProjectionDirty || this.isTransformDirty) &&
          (y = !1),
        this.resolvedRelativeTargetAt === ee.timestamp && (y = !1),
        y)
      )
        return;
      const { layout: p, layoutId: g } = this.options;
      if (
        ((this.isTreeAnimating = !!(
          (this.parent && this.parent.isTreeAnimating) ||
          this.currentAnimation ||
          this.pendingAnimation
        )),
        this.isTreeAnimating ||
          (this.targetDelta = this.relativeTarget = void 0),
        !this.layout || !(p || g))
      )
        return;
      He(this.layoutCorrected, this.layout.layoutBox);
      const x = this.treeScale.x,
        b = this.treeScale.y;
      Jb(this.layoutCorrected, this.treeScale, this.path, m),
        f.layout &&
          !f.target &&
          (this.treeScale.x !== 1 || this.treeScale.y !== 1) &&
          ((f.target = f.layout.layoutBox), (f.targetWithTransforms = Zt()));
      const { target: j } = f;
      if (!j) {
        this.prevProjectionDelta &&
          (this.createProjectionDeltas(), this.scheduleRender());
        return;
      }
      !this.projectionDelta || !this.prevProjectionDelta
        ? this.createProjectionDeltas()
        : (Ip(this.prevProjectionDelta.x, this.projectionDelta.x),
          Ip(this.prevProjectionDelta.y, this.projectionDelta.y)),
        gs(this.projectionDelta, this.layoutCorrected, j, this.latestValues),
        (this.treeScale.x !== x ||
          this.treeScale.y !== b ||
          !cy(this.projectionDelta.x, this.prevProjectionDelta.x) ||
          !cy(this.projectionDelta.y, this.prevProjectionDelta.y)) &&
          ((this.hasProjected = !0),
          this.scheduleRender(),
          this.notifyListeners("projectionUpdate", j));
    }
    hide() {
      this.isVisible = !1;
    }
    show() {
      this.isVisible = !0;
    }
    scheduleRender(f = !0) {
      if ((this.options.visualElement?.scheduleRender(), f)) {
        const m = this.getStack();
        m && m.scheduleRender();
      }
      this.resumingFrom &&
        !this.resumingFrom.instance &&
        (this.resumingFrom = void 0);
    }
    createProjectionDeltas() {
      (this.prevProjectionDelta = la()),
        (this.projectionDelta = la()),
        (this.projectionDeltaWithTransform = la());
    }
    setAnimationOrigin(f, m = !1, y) {
      const p = this.snapshot,
        g = p ? p.latestValues : {},
        x = { ...this.latestValues },
        b = la();
      (!this.relativeParent || !this.relativeParent.options.layoutRoot) &&
        (this.relativeTarget = this.relativeTargetOrigin = void 0),
        (this.attemptToResolveRelativeTarget = !m);
      const j = Zt(),
        A = p ? p.source : void 0,
        R = this.layout ? this.layout.source : void 0,
        V = A !== R,
        L = this.getStack(),
        _ = !L || L.members.length <= 1,
        H = !!(V && !_ && this.options.crossfade === !0 && !this.path.some(FT));
      this.animationProgress = 0;
      let X;
      const k = y?.interpolateProjection(f);
      (this.mixTargetDelta = (tt) => {
        const et = tt / 1e3,
          P = k?.(et);
        P
          ? ((b.x.translate = P.x),
            (b.x.scale = Ot(f.x.scale, 1, et)),
            (b.x.origin = f.x.origin),
            (b.x.originPoint = f.x.originPoint),
            (b.y.translate = P.y),
            (b.y.scale = Ot(f.y.scale, 1, et)),
            (b.y.origin = f.y.origin),
            (b.y.originPoint = f.y.originPoint))
          : (gy(b.x, f.x, et), gy(b.y, f.y, et)),
          this.setTargetDelta(b),
          this.relativeTarget &&
            this.relativeTargetOrigin &&
            this.layout &&
            this.relativeParent &&
            this.relativeParent.layout &&
            (br(
              j,
              this.layout.layoutBox,
              this.relativeParent.layout.layoutBox,
              this.options.layoutAnchor || void 0,
            ),
            JT(this.relativeTarget, this.relativeTargetOrigin, j, et),
            X && AT(this.relativeTarget, X) && (this.isProjectionDirty = !1),
            X || (X = Zt()),
            He(X, this.relativeTarget)),
          V &&
            ((this.animationValues = x), DT(x, g, this.latestValues, et, H, _)),
          P &&
            P.rotate !== void 0 &&
            (this.animationValues || (this.animationValues = x),
            (this.animationValues.pathRotation = P.rotate)),
          this.root.scheduleUpdateProjection(),
          this.scheduleRender(),
          (this.animationProgress = et);
      }),
        this.mixTargetDelta(this.options.layoutRoot ? 1e3 : 0);
    }
    startAnimation(f) {
      this.notifyListeners("animationStart"),
        this.currentAnimation?.stop(),
        this.resumingFrom?.currentAnimation?.stop(),
        this.pendingAnimation &&
          (pn(this.pendingAnimation), (this.pendingAnimation = void 0)),
        (this.pendingAnimation = Et.update(() => {
          (fr.hasAnimatedSinceResize = !0),
            this.motionValue || (this.motionValue = gi(0)),
            this.motionValue.jump(0, !1),
            (this.currentAnimation = jT(this.motionValue, [0, 1e3], {
              ...f,
              velocity: 0,
              isSync: !0,
              onUpdate: (m) => {
                this.mixTargetDelta(m), f.onUpdate && f.onUpdate(m);
              },
              onComplete: () => {
                f.onComplete && f.onComplete(), this.completeAnimation();
              },
            })),
            this.resumingFrom &&
              (this.resumingFrom.currentAnimation = this.currentAnimation),
            (this.pendingAnimation = void 0);
        }));
    }
    completeAnimation() {
      this.resumingFrom &&
        ((this.resumingFrom.currentAnimation = void 0),
        (this.resumingFrom.preserveOpacity = void 0));
      const f = this.getStack();
      f && f.exitAnimationComplete(),
        (this.resumingFrom =
          this.currentAnimation =
          this.animationValues =
            void 0),
        this.notifyListeners("animationComplete");
    }
    finishAnimation() {
      this.currentAnimation &&
        (this.mixTargetDelta && this.mixTargetDelta(LT),
        this.currentAnimation.stop()),
        this.completeAnimation();
    }
    applyTransformsToTarget() {
      const f = this.getLead();
      let {
        targetWithTransforms: m,
        target: y,
        layout: p,
        latestValues: g,
      } = f;
      if (!(!m || !y || !p)) {
        if (
          this !== f &&
          this.layout &&
          p &&
          h0(this.options.animationType, this.layout.layoutBox, p.layoutBox)
        ) {
          y = this.target || Zt();
          const x = oe(this.layout.layoutBox.x);
          (y.x.min = f.target.x.min), (y.x.max = y.x.min + x);
          const b = oe(this.layout.layoutBox.y);
          (y.y.min = f.target.y.min), (y.y.max = y.y.min + b);
        }
        He(m, y),
          ur(m, g),
          gs(this.projectionDeltaWithTransform, this.layoutCorrected, m, g);
      }
    }
    registerSharedNode(f, m) {
      this.sharedNodes.has(f) || this.sharedNodes.set(f, new _T()),
        this.sharedNodes.get(f).add(m);
      const p = m.options.initialPromotionConfig;
      m.promote({
        transition: p ? p.transition : void 0,
        preserveFollowOpacity:
          p && p.shouldPreserveFollowOpacity
            ? p.shouldPreserveFollowOpacity(m)
            : void 0,
      });
    }
    isLead() {
      const f = this.getStack();
      return f ? f.lead === this : !0;
    }
    getLead() {
      const { layoutId: f } = this.options;
      return f ? this.getStack()?.lead || this : this;
    }
    getPrevLead() {
      const { layoutId: f } = this.options;
      return f ? this.getStack()?.prevLead : void 0;
    }
    getStack() {
      const { layoutId: f } = this.options;
      if (f) return this.root.sharedNodes.get(f);
    }
    promote({ needsReset: f, transition: m, preserveFollowOpacity: y } = {}) {
      const p = this.getStack();
      p && p.promote(this, y),
        f && ((this.projectionDelta = void 0), (this.needsReset = !0)),
        m && this.setOptions({ transition: m });
    }
    relegate() {
      const f = this.getStack();
      return f ? f.relegate(this) : !1;
    }
    resetSkewAndRotation() {
      const { visualElement: f } = this.options;
      if (!f) return;
      let m = !1;
      const { latestValues: y } = f;
      if (
        ((y.z ||
          y.rotate ||
          y.rotateX ||
          y.rotateY ||
          y.rotateZ ||
          y.skewX ||
          y.skewY) &&
          (m = !0),
        !m)
      )
        return;
      const p = {};
      y.z && fc("z", f, p, this.animationValues);
      for (let g = 0; g < cc.length; g++)
        fc(`rotate${cc[g]}`, f, p, this.animationValues),
          fc(`skew${cc[g]}`, f, p, this.animationValues);
      f.render();
      for (const g in p)
        f.setStaticValue(g, p[g]),
          this.animationValues && (this.animationValues[g] = p[g]);
      f.scheduleRender();
    }
    applyProjectionStyles(f, m) {
      if (!this.instance || this.isSVG) return;
      if (!this.isVisible) {
        f.visibility = "hidden";
        return;
      }
      const y = this.getTransformTemplate();
      if (this.needsReset) {
        (this.needsReset = !1),
          (f.visibility = ""),
          (f.opacity = ""),
          (f.pointerEvents = cr(m?.pointerEvents) || ""),
          (f.transform = y ? y(this.latestValues, "") : "none");
        return;
      }
      const p = this.getLead();
      if (!this.projectionDelta || !this.layout || !p.target) {
        this.options.layoutId &&
          ((f.opacity =
            this.latestValues.opacity !== void 0
              ? this.latestValues.opacity
              : 1),
          (f.pointerEvents = cr(m?.pointerEvents) || "")),
          this.hasProjected &&
            !ci(this.latestValues) &&
            ((f.transform = y ? y({}, "") : "none"), (this.hasProjected = !1));
        return;
      }
      f.visibility = "";
      const g = p.animationValues || p.latestValues;
      this.applyTransformsToTarget();
      let x = MT(this.projectionDeltaWithTransform, this.treeScale, g);
      y && (x = y(g, x)), (f.transform = x);
      const { x: b, y: j } = this.projectionDelta;
      (f.transformOrigin = `${b.origin * 100}% ${j.origin * 100}% 0`),
        p.animationValues
          ? (f.opacity =
              p === this
                ? (g.opacity ?? this.latestValues.opacity ?? 1)
                : this.preserveOpacity
                  ? this.latestValues.opacity
                  : g.opacityExit)
          : (f.opacity =
              p === this
                ? g.opacity !== void 0
                  ? g.opacity
                  : ""
                : g.opacityExit !== void 0
                  ? g.opacityExit
                  : 0);
      for (const A in Bc) {
        if (g[A] === void 0) continue;
        const { correct: R, applyTo: V, isCSSVariable: L } = Bc[A],
          _ = x === "none" ? g[A] : R(g[A], p);
        if (V) {
          const H = V.length;
          for (let X = 0; X < H; X++) f[V[X]] = _;
        } else
          L ? (this.options.visualElement.renderState.vars[A] = _) : (f[A] = _);
      }
      this.options.layoutId &&
        (f.pointerEvents = p === this ? cr(m?.pointerEvents) || "" : "none");
    }
    clearSnapshot() {
      this.resumeFrom = this.snapshot = void 0;
    }
    resetTree() {
      this.root.nodes.forEach((f) => f.currentAnimation?.stop()),
        this.root.nodes.forEach(my),
        this.root.sharedNodes.clear();
    }
  };
}
function UT(i) {
  i.updateLayout();
}
function BT(i) {
  const a = i.resumeFrom?.snapshot || i.snapshot;
  if (i.isLead() && i.layout && a && i.hasListeners("didUpdate")) {
    const { layoutBox: r, measuredBox: l } = i.layout,
      { animationType: c } = i.options,
      d = a.source !== i.layout.source;
    if (c === "size")
      Qe((g) => {
        const x = d ? a.measuredBox[g] : a.layoutBox[g],
          b = oe(x);
        (x.min = r[g].min), (x.max = x.min + b);
      });
    else if (c === "x" || c === "y") {
      const g = c === "x" ? "y" : "x";
      Hc(d ? a.measuredBox[g] : a.layoutBox[g], r[g]);
    } else
      h0(c, a.layoutBox, r) &&
        Qe((g) => {
          const x = d ? a.measuredBox[g] : a.layoutBox[g],
            b = oe(r[g]);
          (x.max = x.min + b),
            i.relativeTarget &&
              !i.currentAnimation &&
              ((i.isProjectionDirty = !0),
              (i.relativeTarget[g].max = i.relativeTarget[g].min + b));
        });
    const f = la();
    gs(f, r, a.layoutBox);
    const m = la();
    d ? gs(m, i.applyTransform(l, !0), a.measuredBox) : gs(m, r, a.layoutBox);
    const y = !o0(f);
    let p = !1;
    if (!i.resumeFrom) {
      const g = i.getClosestProjectingParent();
      if (g && !g.resumeFrom) {
        const { snapshot: x, layout: b } = g;
        if (x && b) {
          const j = i.options.layoutAnchor || void 0,
            A = Zt();
          br(A, a.layoutBox, x.layoutBox, j);
          const R = Zt();
          br(R, r, b.layoutBox, j),
            u0(A, R) || (p = !0),
            g.options.layoutRoot &&
              ((i.relativeTarget = R),
              (i.relativeTargetOrigin = A),
              (i.relativeParent = g));
        }
      }
    }
    i.notifyListeners("didUpdate", {
      layout: r,
      snapshot: a,
      delta: m,
      layoutDelta: f,
      hasLayoutChanged: y,
      hasRelativeLayoutChanged: p,
    });
  } else if (i.isLead()) {
    const { onExitComplete: r } = i.options;
    r && r();
  }
  i.options.transition = void 0;
}
function HT(i) {
  i.parent &&
    (i.isProjecting() || (i.isProjectionDirty = i.parent.isProjectionDirty),
    i.isSharedProjectionDirty ||
      (i.isSharedProjectionDirty = !!(
        i.isProjectionDirty ||
        i.parent.isProjectionDirty ||
        i.parent.isSharedProjectionDirty
      )),
    i.isTransformDirty || (i.isTransformDirty = i.parent.isTransformDirty));
}
function GT(i) {
  i.isProjectionDirty = i.isSharedProjectionDirty = i.isTransformDirty = !1;
}
function YT(i) {
  i.clearSnapshot();
}
function my(i) {
  i.clearMeasurements();
}
function qT(i) {
  (i.isLayoutDirty = !0), i.updateLayout();
}
function py(i) {
  i.isLayoutDirty = !1;
}
function XT(i) {
  i.isAnimationBlocked &&
    i.layout &&
    !i.isLayoutDirty &&
    ((i.snapshot = i.layout), (i.isLayoutDirty = !0));
}
function kT(i) {
  const { visualElement: a } = i.options;
  a && a.getProps().onBeforeLayoutMeasure && a.notify("BeforeLayoutMeasure"),
    i.resetTransform();
}
function yy(i) {
  i.finishAnimation(),
    (i.targetDelta = i.relativeTarget = i.target = void 0),
    (i.isProjectionDirty = !0);
}
function ZT(i) {
  i.resolveTargetDelta();
}
function KT(i) {
  i.calcProjection();
}
function PT(i) {
  i.resetSkewAndRotation();
}
function QT(i) {
  i.removeLeadSnapshot();
}
function gy(i, a, r) {
  (i.translate = Ot(a.translate, 0, r)),
    (i.scale = Ot(a.scale, 1, r)),
    (i.origin = a.origin),
    (i.originPoint = a.originPoint);
}
function vy(i, a, r, l) {
  (i.min = Ot(a.min, r.min, l)), (i.max = Ot(a.max, r.max, l));
}
function JT(i, a, r, l) {
  vy(i.x, a.x, r.x, l), vy(i.y, a.y, r.y, l);
}
function FT(i) {
  return i.animationValues && i.animationValues.opacityExit !== void 0;
}
const $T = { duration: 0.45, ease: [0.4, 0, 0.1, 1] },
  Sy = (i) =>
    typeof navigator < "u" &&
    navigator.userAgent &&
    navigator.userAgent.toLowerCase().includes(i),
  xy = Sy("applewebkit/") && !Sy("chrome/") ? Math.round : Le;
function by(i) {
  (i.min = xy(i.min)), (i.max = xy(i.max));
}
function WT(i) {
  by(i.x), by(i.y);
}
function h0(i, a, r) {
  return (
    i === "position" || (i === "preserve-aspect" && !ST(uy(a), uy(r), 0.2))
  );
}
function IT(i) {
  return i !== i.root && i.scroll?.wasRoot;
}
const tE = d0({
    attachResizeListener: (i, a) => Es(i, "resize", a),
    measureScroll: () => ({
      x: document.documentElement.scrollLeft || document.body?.scrollLeft || 0,
      y: document.documentElement.scrollTop || document.body?.scrollTop || 0,
    }),
    checkIsScrollRoot: () => !0,
  }),
  eE = (i) => !i.isLayoutDirty && i.willUpdate(!1);
function Ty() {
  const i = new Set(),
    a = new WeakMap(),
    r = () => i.forEach(eE);
  return {
    add: (l) => {
      i.add(l), a.set(l, l.addEventListener("willUpdate", r));
    },
    remove: (l) => {
      i.delete(l);
      const c = a.get(l);
      c && (c(), a.delete(l)), r();
    },
    dirty: r,
  };
}
const dc = { current: void 0 },
  m0 = d0({
    measureScroll: (i) => ({ x: i.scrollLeft, y: i.scrollTop }),
    defaultParent: () => {
      if (!dc.current) {
        const i = new tE({});
        i.mount(window), i.setOptions({ layoutScroll: !0 }), (dc.current = i);
      }
      return dc.current;
    },
    resetTransform: (i, a) => {
      i.style.transform = a !== void 0 ? a : "none";
    },
    checkIsScrollRoot: (i) => window.getComputedStyle(i).position === "fixed",
  }),
  Os = U.createContext({
    transformPagePoint: (i) => i,
    isStatic: !1,
    reducedMotion: "never",
  });
function Ey(i, a) {
  if (typeof i == "function") return i(a);
  i != null && (i.current = a);
}
function nE(...i) {
  return (a) => {
    let r = !1;
    const l = i.map((c) => {
      const d = Ey(c, a);
      return !r && typeof d == "function" && (r = !0), d;
    });
    if (r)
      return () => {
        for (let c = 0; c < l.length; c++) {
          const d = l[c];
          typeof d == "function" ? d() : Ey(i[c], null);
        }
      };
  };
}
function iE(...i) {
  return U.useCallback(nE(...i), i);
}
class aE extends U.Component {
  getSnapshotBeforeUpdate(a) {
    const r = this.props.childRef.current;
    if (
      ar(r) &&
      a.isPresent &&
      !this.props.isPresent &&
      this.props.pop !== !1
    ) {
      const l = r.offsetParent,
        c = (ar(l) && l.offsetWidth) || 0,
        d = (ar(l) && l.offsetHeight) || 0,
        f = getComputedStyle(r),
        m = this.props.sizeRef.current;
      (m.height = parseFloat(f.height)),
        (m.width = parseFloat(f.width)),
        (m.top = r.offsetTop),
        (m.left = r.offsetLeft),
        (m.right = c - m.width - m.left),
        (m.bottom = d - m.height - m.top),
        (m.direction = f.direction);
    }
    return null;
  }
  componentDidUpdate() {}
  render() {
    return this.props.children;
  }
}
function sE({
  children: i,
  isPresent: a,
  anchorX: r,
  anchorY: l,
  root: c,
  pop: d,
}) {
  const f = U.useId(),
    m = U.useRef(null),
    y = U.useRef({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      direction: "ltr",
    }),
    { nonce: p } = U.useContext(Os),
    g = d !== !1 ? (i.props?.ref ?? i?.ref) : void 0,
    x = iE(m, g);
  return (
    U.useInsertionEffect(() => {
      const {
        width: b,
        height: j,
        top: A,
        left: R,
        right: V,
        bottom: L,
        direction: _,
      } = y.current;
      if (a || d === !1 || !m.current || !b || !j) return;
      const H = _ === "rtl",
        X =
          r === "left"
            ? H
              ? `right: ${V}`
              : `left: ${R}`
            : H
              ? `left: ${R}`
              : `right: ${V}`,
        k = l === "bottom" ? `bottom: ${L}` : `top: ${A}`;
      m.current.dataset.motionPopId = f;
      const tt = document.createElement("style");
      p && (tt.nonce = p);
      const et = c ?? document.head;
      return (
        et.appendChild(tt),
        tt.sheet &&
          tt.sheet.insertRule(`
          [data-motion-pop-id="${f}"] {
            position: absolute !important;
            width: ${b}px !important;
            height: ${j}px !important;
            ${X}px !important;
            ${k}px !important;
          }
        `),
        () => {
          m.current?.removeAttribute("data-motion-pop-id"),
            et.contains(tt) && et.removeChild(tt);
        }
      );
    }, [a]),
    S.jsx(aE, {
      isPresent: a,
      childRef: m,
      sizeRef: y,
      pop: d,
      children: d === !1 ? i : U.cloneElement(i, { ref: x }),
    })
  );
}
const lE = ({
  children: i,
  initial: a,
  isPresent: r,
  onExitComplete: l,
  custom: c,
  presenceAffectsLayout: d,
  mode: f,
  anchorX: m,
  anchorY: y,
  root: p,
}) => {
  const g = Er(rE),
    x = U.useId(),
    b = U.useRef(r),
    j = U.useRef(l);
  Ar(() => {
    (b.current = r), (j.current = l);
  });
  let A = !0,
    R = U.useMemo(
      () => (
        (A = !1),
        {
          id: x,
          initial: a,
          isPresent: r,
          custom: c,
          onExitComplete: (V) => {
            g.set(V, !0);
            for (const L of g.values()) if (!L) return;
            l && l();
          },
          register: (V) => (
            g.set(V, !1),
            () => {
              g.delete(V), !b.current && !g.size && j.current?.();
            }
          ),
        }
      ),
      [r, g, l],
    );
  return (
    d && A && (R = { ...R }),
    U.useMemo(() => {
      g.forEach((V, L) => g.set(L, !1));
    }, [r]),
    U.useEffect(() => {
      !r && !g.size && l && l();
    }, [r]),
    (i = S.jsx(sE, {
      pop: f === "popLayout",
      isPresent: r,
      anchorX: m,
      anchorY: y,
      root: p,
      children: i,
    })),
    S.jsx(Mr.Provider, { value: R, children: i })
  );
};
function rE() {
  return new Map();
}
function p0(i = !0) {
  const a = U.useContext(Mr);
  if (a === null) return [!0, null];
  const { isPresent: r, onExitComplete: l, register: c } = a,
    d = U.useId();
  U.useEffect(() => {
    if (i) return c(d);
  }, [i]);
  const f = U.useCallback(() => i && l && l(d), [d, l, i]);
  return !r && l ? [!1, f] : [!0];
}
const Il = (i) => i.key || "";
function Ay(i) {
  const a = [];
  return (
    U.Children.forEach(i, (r) => {
      U.isValidElement(r) && a.push(r);
    }),
    a
  );
}
const fa = ({
    children: i,
    custom: a,
    initial: r = !0,
    onExitComplete: l,
    presenceAffectsLayout: c = !0,
    mode: d = "sync",
    propagate: f = !1,
    anchorX: m = "left",
    anchorY: y = "top",
    root: p,
  }) => {
    const [g, x] = p0(f),
      b = U.useMemo(() => Ay(i), [i]),
      j = f && !g ? [] : b.map(Il),
      A = U.useRef(!0),
      R = U.useRef(b),
      V = Er(() => new Map()),
      L = U.useRef(new Set()),
      [_, H] = U.useState(b),
      [X, k] = U.useState(b);
    Ar(() => {
      (A.current = !1), (R.current = b);
      for (let P = 0; P < X.length; P++) {
        const lt = Il(X[P]);
        j.includes(lt)
          ? (V.delete(lt), L.current.delete(lt))
          : V.get(lt) !== !0 && V.set(lt, !1);
      }
    }, [X, j.length, j.join("-")]);
    const tt = [];
    if (b !== _) {
      let P = [...b];
      for (let lt = 0; lt < X.length; lt++) {
        const W = X[lt],
          mt = Il(W);
        j.includes(mt) || (P.splice(lt, 0, W), tt.push(W));
      }
      return d === "wait" && tt.length && (P = tt), k(Ay(P)), H(b), null;
    }
    const { forceRender: et } = U.useContext(Ss);
    return S.jsx(S.Fragment, {
      children: X.map((P) => {
        const lt = Il(P),
          W = f && !g ? !1 : b === X || j.includes(lt),
          mt = () => {
            if (L.current.has(lt)) return;
            if (V.has(lt)) L.current.add(lt), V.set(lt, !0);
            else return;
            let pt = !0;
            V.forEach(($t) => {
              $t || (pt = !1);
            }),
              pt && (et?.(), k(R.current), f && x?.(), l && l());
          };
        return S.jsx(
          lE,
          {
            isPresent: W,
            initial: !A.current || r ? void 0 : !1,
            custom: a,
            presenceAffectsLayout: c,
            mode: d,
            root: p,
            onExitComplete: W ? void 0 : mt,
            anchorX: m,
            anchorY: y,
            children: P,
          },
          lt,
        );
      }),
    });
  },
  oE = U.createContext(null);
function uE() {
  const i = U.useRef(!1);
  return (
    Ar(
      () => (
        (i.current = !0),
        () => {
          i.current = !1;
        }
      ),
      [],
    ),
    i
  );
}
function cE() {
  const i = uE(),
    [a, r] = U.useState(0),
    l = U.useCallback(() => {
      i.current && r(a + 1);
    }, [a]);
  return [U.useCallback(() => Et.postRender(l), [l]), a];
}
const y0 = (i) => i === !0,
  fE = (i) => y0(i === !0) || i === "id",
  dE = ({ children: i, id: a, inherit: r = !0 }) => {
    const l = U.useContext(Ss),
      c = U.useContext(oE),
      [d, f] = cE(),
      m = U.useRef(null),
      y = l.id || c;
    m.current === null &&
      (fE(r) && y && (a = a ? y + "-" + a : y),
      (m.current = { id: a, group: (y0(r) && l.group) || Ty() }));
    const p = U.useMemo(() => ({ ...m.current, forceRender: d }), [f]);
    return S.jsx(Ss.Provider, { value: p, children: i });
  },
  g0 = U.createContext({ strict: !1 }),
  My = {
    animation: [
      "animate",
      "variants",
      "whileHover",
      "whileTap",
      "exit",
      "whileInView",
      "whileFocus",
      "whileDrag",
    ],
    exit: ["exit"],
    drag: ["drag", "dragControls"],
    focus: ["whileFocus"],
    hover: ["whileHover", "onHoverStart", "onHoverEnd"],
    tap: ["whileTap", "onTap", "onTapStart", "onTapCancel"],
    pan: ["onPan", "onPanStart", "onPanSessionStart", "onPanEnd"],
    inView: ["whileInView", "onViewportEnter", "onViewportLeave"],
    layout: ["layout", "layoutId"],
  };
let Ry = !1;
function hE() {
  if (Ry) return;
  const i = {};
  for (const a in My) i[a] = { isEnabled: (r) => My[a].some((l) => !!r[l]) };
  Kg(i), (Ry = !0);
}
function v0() {
  return hE(), Zb();
}
function mE(i) {
  const a = v0();
  for (const r in i) a[r] = { ...a[r], ...i[r] };
  Kg(a);
}
const pE = new Set([
  "animate",
  "exit",
  "variants",
  "initial",
  "style",
  "values",
  "variants",
  "transition",
  "transformTemplate",
  "custom",
  "inherit",
  "onBeforeLayoutMeasure",
  "onAnimationStart",
  "onAnimationComplete",
  "onUpdate",
  "onDragStart",
  "onDrag",
  "onDragEnd",
  "onMeasureDragConstraints",
  "onDirectionLock",
  "onDragTransitionEnd",
  "_dragX",
  "_dragY",
  "onHoverStart",
  "onHoverEnd",
  "onViewportEnter",
  "onViewportLeave",
  "globalTapTarget",
  "propagate",
  "ignoreStrict",
  "viewport",
]);
function Tr(i) {
  return (
    i.startsWith("while") ||
    (i.startsWith("drag") && i !== "draggable") ||
    i.startsWith("layout") ||
    i.startsWith("onTap") ||
    i.startsWith("onPan") ||
    i.startsWith("onLayout") ||
    pE.has(i)
  );
}
let S0 = (i) => !Tr(i);
function yE(i) {
  typeof i == "function" && (S0 = (a) => (a.startsWith("on") ? !Tr(a) : i(a)));
}
try {
  yE(require("@emotion/is-prop-valid").default);
} catch {}
function gE(i, a, r) {
  const l = {};
  for (const c in i)
    (c === "values" && typeof i.values == "object") ||
      ne(i[c]) ||
      ((S0(c) ||
        (r === !0 && Tr(c)) ||
        (!a && !Tr(c)) ||
        (i.draggable && c.startsWith("onDrag"))) &&
        (l[c] = i[c]));
  return l;
}
const jr = U.createContext({});
function vE(i, a) {
  if (Cr(i)) {
    const { initial: r, animate: l } = i;
    return {
      initial: r === !1 || Ts(r) ? r : void 0,
      animate: Ts(l) ? l : void 0,
    };
  }
  return i.inherit !== !1 ? a : {};
}
function SE(i) {
  const { initial: a, animate: r } = vE(i, U.useContext(jr));
  return U.useMemo(() => ({ initial: a, animate: r }), [Dy(a), Dy(r)]);
}
function Dy(i) {
  return Array.isArray(i) ? i.join(" ") : i;
}
const gf = () => ({ style: {}, transform: {}, transformOrigin: {}, vars: {} });
function x0(i, a, r) {
  for (const l in a) !ne(a[l]) && !Ig(l, r) && (i[l] = a[l]);
}
function xE({ transformTemplate: i }, a) {
  return U.useMemo(() => {
    const r = gf();
    return pf(r, a, i), Object.assign({}, r.vars, r.style);
  }, [a]);
}
function bE(i, a) {
  const r = i.style || {},
    l = {};
  return x0(l, r, i), Object.assign(l, xE(i, a)), l;
}
function TE(i, a) {
  const r = {},
    l = bE(i, a);
  return (
    i.drag &&
      i.dragListener !== !1 &&
      ((r.draggable = !1),
      (l.userSelect = l.WebkitUserSelect = l.WebkitTouchCallout = "none"),
      (l.touchAction =
        i.drag === !0 ? "none" : `pan-${i.drag === "x" ? "y" : "x"}`)),
    i.tabIndex === void 0 &&
      (i.onTap || i.onTapStart || i.whileTap) &&
      (r.tabIndex = 0),
    (r.style = l),
    r
  );
}
const b0 = () => ({ ...gf(), attrs: {} });
function EE(i, a, r, l) {
  const c = U.useMemo(() => {
    const d = b0();
    return (
      t0(d, a, n0(l), i.transformTemplate, i.style),
      { ...d.attrs, style: { ...d.style } }
    );
  }, [a]);
  if (i.style) {
    const d = {};
    x0(d, i.style, i), (c.style = { ...d, ...c.style });
  }
  return c;
}
const AE = [
  "animate",
  "circle",
  "defs",
  "desc",
  "ellipse",
  "g",
  "image",
  "line",
  "filter",
  "marker",
  "mask",
  "metadata",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "rect",
  "stop",
  "switch",
  "symbol",
  "svg",
  "text",
  "tspan",
  "use",
  "view",
];
function vf(i) {
  return typeof i != "string" || i.includes("-")
    ? !1
    : !!(AE.indexOf(i) > -1 || /[A-Z]/u.test(i));
}
function ME(i, a, r, { latestValues: l }, c, d = !1, f) {
  const y = ((f ?? vf(i)) ? EE : TE)(a, l, c, i),
    p = gE(a, typeof i == "string", d),
    g = i !== U.Fragment ? { ...p, ...y, ref: r } : {},
    { children: x } = a,
    b = U.useMemo(() => (ne(x) ? x.get() : x), [x]);
  return U.createElement(i, { ...g, children: b });
}
function RE({ scrapeMotionValuesFromProps: i, createRenderState: a }, r, l, c) {
  return { latestValues: DE(r, l, c, i), renderState: a() };
}
function DE(i, a, r, l) {
  const c = {},
    d = l(i, {});
  for (const b in d) c[b] = cr(d[b]);
  let { initial: f, animate: m } = i;
  const y = Cr(i),
    p = kg(i);
  a &&
    p &&
    !y &&
    i.inherit !== !1 &&
    (f === void 0 && (f = a.initial), m === void 0 && (m = a.animate));
  let g = r ? r.initial === !1 : !1;
  g = g || f === !1;
  const x = g ? m : f;
  if (x && typeof x != "boolean" && !Or(x)) {
    const b = Array.isArray(x) ? x : [x];
    for (let j = 0; j < b.length; j++) {
      const A = lf(i, b[j]);
      if (A) {
        const { transitionEnd: R, transition: V, ...L } = A;
        for (const _ in L) {
          let H = L[_];
          if (Array.isArray(H)) {
            const X = g ? H.length - 1 : 0;
            H = H[X];
          }
          H !== null && (c[_] = H);
        }
        for (const _ in R) c[_] = R[_];
      }
    }
  }
  return c;
}
const T0 = (i) => (a, r) => {
    const l = U.useContext(jr),
      c = U.useContext(Mr),
      d = () => RE(i, a, l, c);
    return r ? d() : Er(d);
  },
  OE = T0({ scrapeMotionValuesFromProps: yf, createRenderState: gf }),
  CE = T0({ scrapeMotionValuesFromProps: i0, createRenderState: b0 }),
  jE = Symbol.for("motionComponentSymbol");
function NE(i, a, r) {
  const l = U.useRef(r);
  U.useInsertionEffect(() => {
    l.current = r;
  });
  const c = U.useRef(null);
  return U.useCallback(
    (d) => {
      d && i.onMount?.(d), a && (d ? a.mount(d) : a.unmount());
      const f = l.current;
      if (typeof f == "function")
        if (d) {
          const m = f(d);
          typeof m == "function" && (c.current = m);
        } else c.current ? (c.current(), (c.current = null)) : f(d);
      else f && (f.current = d);
    },
    [a],
  );
}
const E0 = U.createContext({});
function ia(i) {
  return (
    i &&
    typeof i == "object" &&
    Object.prototype.hasOwnProperty.call(i, "current")
  );
}
function wE(i, a, r, l, c, d) {
  const { visualElement: f } = U.useContext(jr),
    m = U.useContext(g0),
    y = U.useContext(Mr),
    p = U.useContext(Os),
    g = p.reducedMotion,
    x = p.skipAnimations,
    b = U.useRef(null),
    j = U.useRef(!1);
  (l = l || m.renderer),
    !b.current &&
      l &&
      ((b.current = l(i, {
        visualState: a,
        parent: f,
        props: r,
        presenceContext: y,
        blockInitialAnimation: y ? y.initial === !1 : !1,
        reducedMotionConfig: g,
        skipAnimations: x,
        isSVG: d,
      })),
      j.current && b.current && (b.current.manuallyAnimateOnMount = !0));
  const A = b.current,
    R = U.useContext(E0);
  A &&
    !A.projection &&
    c &&
    (A.type === "html" || A.type === "svg") &&
    VE(b.current, r, c, R);
  const V = U.useRef(!1);
  U.useInsertionEffect(() => {
    A && V.current && A.update(r, y);
  });
  const L = r[wg],
    _ = U.useRef(
      !!L &&
        typeof window < "u" &&
        !window.MotionHandoffIsComplete?.(L) &&
        window.MotionHasOptimisedAnimation?.(L),
    );
  return (
    Ar(() => {
      (j.current = !0),
        A &&
          ((V.current = !0),
          (window.MotionIsMounted = !0),
          A.updateFeatures(),
          A.scheduleRenderMicrotask(),
          _.current && A.animationState && A.animationState.animateChanges());
    }),
    U.useEffect(() => {
      A &&
        (!_.current && A.animationState && A.animationState.animateChanges(),
        _.current &&
          (queueMicrotask(() => {
            window.MotionHandoffMarkAsComplete?.(L);
          }),
          (_.current = !1)),
        (A.enteringChildren = void 0));
    }),
    A
  );
}
function VE(i, a, r, l) {
  const {
    layoutId: c,
    layout: d,
    drag: f,
    dragConstraints: m,
    layoutScroll: y,
    layoutRoot: p,
    layoutAnchor: g,
    layoutCrossfade: x,
  } = a;
  (i.projection = new r(
    i.latestValues,
    a["data-framer-portal-id"] ? void 0 : A0(i.parent),
  )),
    i.projection.setOptions({
      layoutId: c,
      layout: d,
      alwaysMeasureLayout: !!f || (m && ia(m)),
      visualElement: i,
      animationType: typeof d == "string" ? d : "both",
      initialPromotionConfig: l,
      crossfade: x,
      layoutScroll: y,
      layoutRoot: p,
      layoutAnchor: g,
    });
}
function A0(i) {
  if (i) return i.options.allowProjection !== !1 ? i.projection : A0(i.parent);
}
function hc(i, { forwardMotionProps: a = !1, type: r } = {}, l, c) {
  l && mE(l);
  const d = r ? r === "svg" : vf(i),
    f = d ? CE : OE;
  function m(p, g) {
    let x;
    const b = { ...U.useContext(Os), ...p, layoutId: _E(p) },
      { isStatic: j } = b,
      A = SE(p),
      R = f(p, j);
    if (!j && typeof window < "u") {
      LE();
      const V = zE(b);
      (x = V.MeasureLayout),
        (A.visualElement = wE(i, R, b, c, V.ProjectionNode, d));
    }
    return S.jsxs(jr.Provider, {
      value: A,
      children: [
        x && A.visualElement
          ? S.jsx(x, { visualElement: A.visualElement, ...b })
          : null,
        ME(i, p, NE(R, A.visualElement, g), R, j, a, d),
      ],
    });
  }
  m.displayName = `motion.${typeof i == "string" ? i : `create(${i.displayName ?? i.name ?? ""})`}`;
  const y = U.forwardRef(m);
  return (y[jE] = i), y;
}
function _E({ layoutId: i }) {
  const a = U.useContext(Ss).id;
  return a && i !== void 0 ? a + "-" + i : i;
}
function LE(i, a) {
  U.useContext(g0).strict;
}
function zE(i) {
  const a = v0(),
    { drag: r, layout: l } = a;
  if (!r && !l) return {};
  const c = { ...r, ...l };
  return {
    MeasureLayout:
      r?.isEnabled(i) || l?.isEnabled(i) ? c.MeasureLayout : void 0,
    ProjectionNode: c.ProjectionNode,
  };
}
function UE(i, a) {
  if (typeof Proxy > "u") return hc;
  const r = new Map(),
    l = (d, f) => hc(d, f, i, a),
    c = (d, f) => l(d, f);
  return new Proxy(c, {
    get: (d, f) =>
      f === "create"
        ? l
        : (r.has(f) || r.set(f, hc(f, void 0, i, a)), r.get(f)),
  });
}
const BE = (i, a) =>
  (a.isSVG ?? vf(i))
    ? new oT(a)
    : new nT(a, { allowProjection: i !== U.Fragment });
class HE extends kn {
  constructor(a) {
    super(a), a.animationState || (a.animationState = hT(a));
  }
  updateAnimationControlsSubscription() {
    const { animate: a } = this.node.getProps();
    Or(a) && (this.unmountControls = a.subscribe(this.node));
  }
  mount() {
    this.updateAnimationControlsSubscription();
  }
  update() {
    const { animate: a } = this.node.getProps(),
      { animate: r } = this.node.prevProps || {};
    a !== r && this.updateAnimationControlsSubscription();
  }
  unmount() {
    this.node.animationState.reset(), this.unmountControls?.();
  }
}
let GE = 0;
class YE extends kn {
  constructor() {
    super(...arguments), (this.id = GE++), (this.isExitComplete = !1);
  }
  update() {
    if (!this.node.presenceContext) return;
    const { isPresent: a, onExitComplete: r } = this.node.presenceContext,
      { isPresent: l } = this.node.prevPresenceContext || {};
    if (!this.node.animationState || a === l) return;
    if (a && l === !1) {
      if (this.isExitComplete) {
        const { initial: d, custom: f } = this.node.getProps();
        if (
          typeof d == "string" ||
          (typeof d == "object" && d !== null && !Array.isArray(d))
        ) {
          const m = yi(this.node, d, f);
          if (m) {
            const { transition: y, transitionEnd: p, ...g } = m;
            for (const x in g) this.node.getValue(x)?.jump(g[x]);
          }
        }
        this.node.animationState.reset(),
          this.node.animationState.animateChanges();
      } else this.node.animationState.setActive("exit", !1);
      this.isExitComplete = !1;
      return;
    }
    const c = this.node.animationState.setActive("exit", !a);
    r &&
      !a &&
      c.then(() => {
        (this.isExitComplete = !0), r(this.id);
      });
  }
  mount() {
    const { register: a, onExitComplete: r } = this.node.presenceContext || {};
    r && r(this.id), a && (this.unmount = a(this.id));
  }
  unmount() {}
}
const qE = { animation: { Feature: HE }, exit: { Feature: YE } };
function Cs(i) {
  return { point: { x: i.pageX, y: i.pageY } };
}
const XE = (i) => (a) => cf(a) && i(a, Cs(a));
function vs(i, a, r, l) {
  return Es(i, a, XE(r), l);
}
const M0 = ({ current: i }) => (i ? i.ownerDocument.defaultView : null),
  Oy = (i, a) => Math.abs(i - a);
function kE(i, a) {
  const r = Oy(i.x, a.x),
    l = Oy(i.y, a.y);
  return Math.sqrt(r ** 2 + l ** 2);
}
const Cy = new Set(["auto", "scroll"]);
class R0 {
  constructor(
    a,
    r,
    {
      transformPagePoint: l,
      contextWindow: c = window,
      dragSnapToOrigin: d = !1,
      distanceThreshold: f = 3,
      element: m,
    } = {},
  ) {
    if (
      ((this.startEvent = null),
      (this.lastMoveEvent = null),
      (this.lastMoveEventInfo = null),
      (this.lastRawMoveEventInfo = null),
      (this.handlers = {}),
      (this.contextWindow = window),
      (this.scrollPositions = new Map()),
      (this.removeScrollListeners = null),
      (this.onElementScroll = (A) => {
        this.handleScroll(A.target);
      }),
      (this.onWindowScroll = () => {
        this.handleScroll(window);
      }),
      (this.updatePoint = () => {
        if (!(this.lastMoveEvent && this.lastMoveEventInfo)) return;
        this.lastRawMoveEventInfo &&
          (this.lastMoveEventInfo = tr(
            this.lastRawMoveEventInfo,
            this.transformPagePoint,
          ));
        const A = mc(this.lastMoveEventInfo, this.history),
          R = this.startEvent !== null,
          V = kE(A.offset, { x: 0, y: 0 }) >= this.distanceThreshold;
        if (!R && !V) return;
        const { point: L } = A,
          { timestamp: _ } = ee;
        this.history.push({ ...L, timestamp: _ });
        const { onStart: H, onMove: X } = this.handlers;
        R ||
          (H && H(this.lastMoveEvent, A),
          (this.startEvent = this.lastMoveEvent)),
          X && X(this.lastMoveEvent, A);
      }),
      (this.handlePointerMove = (A, R) => {
        (this.lastMoveEvent = A),
          (this.lastRawMoveEventInfo = R),
          (this.lastMoveEventInfo = tr(R, this.transformPagePoint)),
          Et.update(this.updatePoint, !0);
      }),
      (this.handlePointerUp = (A, R) => {
        this.end();
        const { onEnd: V, onSessionEnd: L, resumeAnimation: _ } = this.handlers;
        if (
          ((this.dragSnapToOrigin || !this.startEvent) && _ && _(),
          !(this.lastMoveEvent && this.lastMoveEventInfo))
        )
          return;
        const H = mc(
          A.type === "pointercancel"
            ? this.lastMoveEventInfo
            : tr(R, this.transformPagePoint),
          this.history,
        );
        this.startEvent && V && V(A, H), L && L(A, H);
      }),
      !cf(a))
    )
      return;
    (this.dragSnapToOrigin = d),
      (this.handlers = r),
      (this.transformPagePoint = l),
      (this.distanceThreshold = f),
      (this.contextWindow = c || window);
    const y = Cs(a),
      p = tr(y, this.transformPagePoint),
      { point: g } = p,
      { timestamp: x } = ee;
    this.history = [{ ...g, timestamp: x }];
    const { onSessionStart: b } = r;
    b && b(a, mc(p, this.history));
    const j = { passive: !0, capture: !0 };
    (this.removeListeners = Ms(
      vs(this.contextWindow, "pointermove", this.handlePointerMove, j),
      vs(this.contextWindow, "pointerup", this.handlePointerUp, j),
      vs(this.contextWindow, "pointercancel", this.handlePointerUp, j),
    )),
      m && this.startScrollTracking(m);
  }
  startScrollTracking(a) {
    let r = a.parentElement;
    for (; r; ) {
      const l = getComputedStyle(r);
      (Cy.has(l.overflowX) || Cy.has(l.overflowY)) &&
        this.scrollPositions.set(r, { x: r.scrollLeft, y: r.scrollTop }),
        (r = r.parentElement);
    }
    this.scrollPositions.set(window, { x: window.scrollX, y: window.scrollY }),
      window.addEventListener("scroll", this.onElementScroll, { capture: !0 }),
      window.addEventListener("scroll", this.onWindowScroll),
      (this.removeScrollListeners = () => {
        window.removeEventListener("scroll", this.onElementScroll, {
          capture: !0,
        }),
          window.removeEventListener("scroll", this.onWindowScroll);
      });
  }
  handleScroll(a) {
    const r = this.scrollPositions.get(a);
    if (!r) return;
    const l = a === window,
      c = l
        ? { x: window.scrollX, y: window.scrollY }
        : { x: a.scrollLeft, y: a.scrollTop },
      d = { x: c.x - r.x, y: c.y - r.y };
    (d.x === 0 && d.y === 0) ||
      (l
        ? this.lastMoveEventInfo &&
          ((this.lastMoveEventInfo.point.x += d.x),
          (this.lastMoveEventInfo.point.y += d.y))
        : this.history.length > 0 &&
          ((this.history[0].x -= d.x), (this.history[0].y -= d.y)),
      this.scrollPositions.set(a, c),
      Et.update(this.updatePoint, !0));
  }
  updateHandlers(a) {
    this.handlers = a;
  }
  end() {
    this.removeListeners && this.removeListeners(),
      this.removeScrollListeners && this.removeScrollListeners(),
      this.scrollPositions.clear(),
      pn(this.updatePoint);
  }
}
function tr(i, a) {
  return a ? { point: a(i.point) } : i;
}
function jy(i, a) {
  return { x: i.x - a.x, y: i.y - a.y };
}
function mc({ point: i }, a) {
  return {
    point: i,
    delta: jy(i, D0(a)),
    offset: jy(i, ZE(a)),
    velocity: KE(a, 0.1),
  };
}
function ZE(i) {
  return i[0];
}
function D0(i) {
  return i[i.length - 1];
}
function KE(i, a) {
  if (i.length < 2) return { x: 0, y: 0 };
  let r = i.length - 1,
    l = null;
  const c = D0(i);
  for (; r >= 0 && ((l = i[r]), !(c.timestamp - l.timestamp > Ae(a))); ) r--;
  if (!l) return { x: 0, y: 0 };
  l === i[0] &&
    i.length > 2 &&
    c.timestamp - l.timestamp > Ae(a) * 2 &&
    (l = i[1]);
  const d = _e(c.timestamp - l.timestamp);
  if (d === 0) return { x: 0, y: 0 };
  const f = { x: (c.x - l.x) / d, y: (c.y - l.y) / d };
  return f.x === 1 / 0 && (f.x = 0), f.y === 1 / 0 && (f.y = 0), f;
}
function PE(i, { min: a, max: r }, l) {
  return (
    a !== void 0 && i < a
      ? (i = l ? Ot(a, i, l.min) : Math.max(i, a))
      : r !== void 0 && i > r && (i = l ? Ot(r, i, l.max) : Math.min(i, r)),
    i
  );
}
function Ny(i, a, r) {
  return {
    min: a !== void 0 ? i.min + a : void 0,
    max: r !== void 0 ? i.max + r - (i.max - i.min) : void 0,
  };
}
function QE(i, { top: a, left: r, bottom: l, right: c }) {
  return { x: Ny(i.x, r, c), y: Ny(i.y, a, l) };
}
function wy(i, a) {
  let r = a.min - i.min,
    l = a.max - i.max;
  return a.max - a.min < i.max - i.min && ([r, l] = [l, r]), { min: r, max: l };
}
function JE(i, a) {
  return { x: wy(i.x, a.x), y: wy(i.y, a.y) };
}
function FE(i, a) {
  let r = 0.5;
  const l = oe(i),
    c = oe(a);
  return (
    c > l
      ? (r = xs(a.min, a.max - l, i.min))
      : l > c && (r = xs(i.min, i.max - c, a.min)),
    $e(0, 1, r)
  );
}
function $E(i, a) {
  const r = {};
  return (
    a.min !== void 0 && (r.min = a.min - i.min),
    a.max !== void 0 && (r.max = a.max - i.min),
    r
  );
}
const Gc = 0.35;
function WE(i = Gc) {
  return (
    i === !1 ? (i = 0) : i === !0 && (i = Gc),
    { x: Vy(i, "left", "right"), y: Vy(i, "top", "bottom") }
  );
}
function Vy(i, a, r) {
  return { min: _y(i, a), max: _y(i, r) };
}
function _y(i, a) {
  return typeof i == "number" ? i : i[a] || 0;
}
const IE = new WeakMap();
class tA {
  constructor(a) {
    (this.openDragLock = null),
      (this.isDragging = !1),
      (this.currentDirection = null),
      (this.originPoint = { x: 0, y: 0 }),
      (this.constraints = !1),
      (this.hasMutatedConstraints = !1),
      (this.elastic = Zt()),
      (this.latestPointerEvent = null),
      (this.latestPanInfo = null),
      (this.visualElement = a);
  }
  start(a, { snapToCursor: r = !1, distanceThreshold: l } = {}) {
    const { presenceContext: c } = this.visualElement;
    if (c && c.isPresent === !1) return;
    const d = (x) => {
        r && this.snapToCursor(Cs(x).point), this.stopAnimation();
      },
      f = (x, b) => {
        const { drag: j, dragPropagation: A, onDragStart: R } = this.getProps();
        if (
          j &&
          !A &&
          (this.openDragLock && this.openDragLock(),
          (this.openDragLock = Tb(j)),
          !this.openDragLock)
        )
          return;
        (this.latestPointerEvent = x),
          (this.latestPanInfo = b),
          (this.isDragging = !0),
          (this.currentDirection = null),
          this.resolveConstraints(),
          this.visualElement.projection &&
            ((this.visualElement.projection.isAnimationBlocked = !0),
            (this.visualElement.projection.target = void 0)),
          Qe((L) => {
            let _ = this.getAxisMotionValue(L).get() || 0;
            if (Fe.test(_)) {
              const { projection: H } = this.visualElement;
              if (H && H.layout) {
                const X = H.layout.layoutBox[L];
                X && (_ = oe(X) * (parseFloat(_) / 100));
              }
            }
            this.originPoint[L] = _;
          }),
          R && Et.update(() => R(x, b), !1, !0),
          Nc(this.visualElement, "transform");
        const { animationState: V } = this.visualElement;
        V && V.setActive("whileDrag", !0);
      },
      m = (x, b) => {
        (this.latestPointerEvent = x), (this.latestPanInfo = b);
        const {
          dragPropagation: j,
          dragDirectionLock: A,
          onDirectionLock: R,
          onDrag: V,
        } = this.getProps();
        if (!j && !this.openDragLock) return;
        const { offset: L } = b;
        if (A && this.currentDirection === null) {
          (this.currentDirection = nA(L)),
            this.currentDirection !== null && R && R(this.currentDirection);
          return;
        }
        this.updateAxis("x", b.point, L),
          this.updateAxis("y", b.point, L),
          this.visualElement.render(),
          V && Et.update(() => V(x, b), !1, !0);
      },
      y = (x, b) => {
        (this.latestPointerEvent = x),
          (this.latestPanInfo = b),
          this.stop(x, b),
          (this.latestPointerEvent = null),
          (this.latestPanInfo = null);
      },
      p = () => {
        const { dragSnapToOrigin: x } = this.getProps();
        (x || this.constraints) && this.startAnimation({ x: 0, y: 0 });
      },
      { dragSnapToOrigin: g } = this.getProps();
    this.panSession = new R0(
      a,
      {
        onSessionStart: d,
        onStart: f,
        onMove: m,
        onSessionEnd: y,
        resumeAnimation: p,
      },
      {
        transformPagePoint: this.visualElement.getTransformPagePoint(),
        dragSnapToOrigin: g,
        distanceThreshold: l,
        contextWindow: M0(this.visualElement),
        element: this.visualElement.current,
      },
    );
  }
  stop(a, r) {
    const l = a || this.latestPointerEvent,
      c = r || this.latestPanInfo,
      d = this.isDragging;
    if ((this.cancel(), !d || !c || !l)) return;
    const { velocity: f } = c;
    this.startAnimation(f);
    const { onDragEnd: m } = this.getProps();
    m && Et.postRender(() => m(l, c));
  }
  cancel() {
    this.isDragging = !1;
    const { projection: a, animationState: r } = this.visualElement;
    a && (a.isAnimationBlocked = !1), this.endPanSession();
    const { dragPropagation: l } = this.getProps();
    !l &&
      this.openDragLock &&
      (this.openDragLock(), (this.openDragLock = null)),
      r && r.setActive("whileDrag", !1);
  }
  endPanSession() {
    this.panSession && this.panSession.end(), (this.panSession = void 0);
  }
  updateAxis(a, r, l) {
    const { drag: c } = this.getProps();
    if (!l || !er(a, c, this.currentDirection)) return;
    const d = this.getAxisMotionValue(a);
    let f = this.originPoint[a] + l[a];
    this.constraints &&
      this.constraints[a] &&
      (f = PE(f, this.constraints[a], this.elastic[a])),
      d.set(f);
  }
  resolveConstraints() {
    const { dragConstraints: a, dragElastic: r } = this.getProps(),
      l =
        this.visualElement.projection && !this.visualElement.projection.layout
          ? this.visualElement.projection.measure(!1)
          : this.visualElement.projection?.layout,
      c = this.constraints;
    a && ia(a)
      ? this.constraints || (this.constraints = this.resolveRefConstraints())
      : a && l
        ? (this.constraints = QE(l.layoutBox, a))
        : (this.constraints = !1),
      (this.elastic = WE(r)),
      c !== this.constraints &&
        !ia(a) &&
        l &&
        this.constraints &&
        !this.hasMutatedConstraints &&
        Qe((d) => {
          this.constraints !== !1 &&
            this.getAxisMotionValue(d) &&
            (this.constraints[d] = $E(l.layoutBox[d], this.constraints[d]));
        });
  }
  resolveRefConstraints() {
    const { dragConstraints: a, onMeasureDragConstraints: r } = this.getProps();
    if (!a || !ia(a)) return !1;
    const l = a.current,
      { projection: c } = this.visualElement;
    if (!c || !c.layout) return !1;
    c.root && ((c.root.scroll = void 0), c.root.updateScroll());
    const d = Fb(l, c.root, this.visualElement.getTransformPagePoint());
    let f = JE(c.layout.layoutBox, d);
    if (r) {
      const m = r(Pb(f));
      (this.hasMutatedConstraints = !!m), m && (f = Qg(m));
    }
    return f;
  }
  startAnimation(a) {
    const {
        drag: r,
        dragMomentum: l,
        dragElastic: c,
        dragTransition: d,
        dragSnapToOrigin: f,
        onDragTransitionEnd: m,
      } = this.getProps(),
      y = this.constraints || {},
      p = Qe((g) => {
        if (!er(g, r, this.currentDirection)) return;
        let x = (y && y[g]) || {};
        (f === !0 || f === g) && (x = { min: 0, max: 0 });
        const b = c ? 200 : 1e6,
          j = c ? 40 : 1e7,
          A = {
            type: "inertia",
            velocity: l ? a[g] : 0,
            bounceStiffness: b,
            bounceDamping: j,
            timeConstant: 750,
            restDelta: 1,
            restSpeed: 10,
            ...d,
            ...x,
          };
        return this.startAxisValueAnimation(g, A);
      });
    return Promise.all(p).then(m);
  }
  startAxisValueAnimation(a, r) {
    const l = this.getAxisMotionValue(a);
    return (
      Nc(this.visualElement, a), l.start(sf(a, l, 0, r, this.visualElement, !1))
    );
  }
  stopAnimation() {
    Qe((a) => this.getAxisMotionValue(a).stop());
  }
  getAxisMotionValue(a) {
    const r = `_drag${a.toUpperCase()}`,
      c = this.visualElement.getProps()[r];
    return (
      c ||
      this.visualElement.getValue(a, this.visualElement.latestValues[a] ?? 0)
    );
  }
  snapToCursor(a) {
    Qe((r) => {
      const { drag: l } = this.getProps();
      if (!er(r, l, this.currentDirection)) return;
      const { projection: c } = this.visualElement,
        d = this.getAxisMotionValue(r);
      if (c && c.layout) {
        const { min: f, max: m } = c.layout.layoutBox[r],
          y = d.get() || 0;
        d.set(a[r] - Ot(f, m, 0.5) + y);
      }
    });
  }
  scalePositionWithinConstraints() {
    if (!this.visualElement.current) return;
    const { drag: a, dragConstraints: r } = this.getProps(),
      { projection: l } = this.visualElement;
    if (!ia(r) || !l || !this.constraints) return;
    this.stopAnimation();
    const c = { x: 0, y: 0 };
    Qe((f) => {
      const m = this.getAxisMotionValue(f);
      if (m && this.constraints !== !1) {
        const y = m.get();
        c[f] = FE({ min: y, max: y }, this.constraints[f]);
      }
    });
    const { transformTemplate: d } = this.visualElement.getProps();
    (this.visualElement.current.style.transform = d ? d({}, "") : "none"),
      l.root && l.root.updateScroll(),
      l.updateLayout(),
      (this.constraints = !1),
      this.resolveConstraints(),
      Qe((f) => {
        if (!er(f, a, null)) return;
        const m = this.getAxisMotionValue(f),
          { min: y, max: p } = this.constraints[f];
        m.set(Ot(y, p, c[f]));
      }),
      this.visualElement.render();
  }
  addListeners() {
    if (!this.visualElement.current) return;
    IE.set(this.visualElement, this);
    const a = this.visualElement.current,
      r = vs(a, "pointerdown", (p) => {
        const { drag: g, dragListener: x = !0 } = this.getProps(),
          b = p.target,
          j = b !== a && Ob(b);
        g && x && !j && this.start(p);
      });
    let l;
    const c = () => {
        const { dragConstraints: p } = this.getProps();
        ia(p) &&
          p.current &&
          ((this.constraints = this.resolveRefConstraints()),
          l ||
            (l = eA(a, p.current, () =>
              this.scalePositionWithinConstraints(),
            )));
      },
      { projection: d } = this.visualElement,
      f = d.addEventListener("measure", c);
    d && !d.layout && (d.root && d.root.updateScroll(), d.updateLayout()),
      Et.read(c);
    const m = Es(window, "resize", () => this.scalePositionWithinConstraints()),
      y = d.addEventListener(
        "didUpdate",
        ({ delta: p, hasLayoutChanged: g }) => {
          this.isDragging &&
            g &&
            (Qe((x) => {
              const b = this.getAxisMotionValue(x);
              b &&
                ((this.originPoint[x] += p[x].translate),
                b.set(b.get() + p[x].translate));
            }),
            this.visualElement.render());
        },
      );
    return () => {
      m(), r(), f(), y && y(), l && l();
    };
  }
  getProps() {
    const a = this.visualElement.getProps(),
      {
        drag: r = !1,
        dragDirectionLock: l = !1,
        dragPropagation: c = !1,
        dragConstraints: d = !1,
        dragElastic: f = Gc,
        dragMomentum: m = !0,
      } = a;
    return {
      ...a,
      drag: r,
      dragDirectionLock: l,
      dragPropagation: c,
      dragConstraints: d,
      dragElastic: f,
      dragMomentum: m,
    };
  }
}
function Ly(i) {
  let a = !0;
  return () => {
    if (a) {
      a = !1;
      return;
    }
    i();
  };
}
function eA(i, a, r) {
  const l = Yp(i, Ly(r)),
    c = Yp(a, Ly(r));
  return () => {
    l(), c();
  };
}
function er(i, a, r) {
  return (a === !0 || a === i) && (r === null || r === i);
}
function nA(i, a = 10) {
  let r = null;
  return Math.abs(i.y) > a ? (r = "y") : Math.abs(i.x) > a && (r = "x"), r;
}
class iA extends kn {
  constructor(a) {
    super(a),
      (this.removeGroupControls = Le),
      (this.removeListeners = Le),
      (this.controls = new tA(a));
  }
  mount() {
    const { dragControls: a } = this.node.getProps();
    a && (this.removeGroupControls = a.subscribe(this.controls)),
      (this.removeListeners = this.controls.addListeners() || Le);
  }
  update() {
    const { dragControls: a } = this.node.getProps(),
      { dragControls: r } = this.node.prevProps || {};
    a !== r &&
      (this.removeGroupControls(),
      a && (this.removeGroupControls = a.subscribe(this.controls)));
  }
  unmount() {
    this.removeGroupControls(),
      this.removeListeners(),
      this.controls.isDragging || this.controls.endPanSession();
  }
}
const pc = (i) => (a, r) => {
  i && Et.update(() => i(a, r), !1, !0);
};
class aA extends kn {
  constructor() {
    super(...arguments), (this.removePointerDownListener = Le);
  }
  onPointerDown(a) {
    this.session = new R0(a, this.createPanHandlers(), {
      transformPagePoint: this.node.getTransformPagePoint(),
      contextWindow: M0(this.node),
    });
  }
  createPanHandlers() {
    const {
      onPanSessionStart: a,
      onPanStart: r,
      onPan: l,
      onPanEnd: c,
    } = this.node.getProps();
    return {
      onSessionStart: pc(a),
      onStart: pc(r),
      onMove: pc(l),
      onEnd: (d, f) => {
        delete this.session, c && Et.postRender(() => c(d, f));
      },
    };
  }
  mount() {
    this.removePointerDownListener = vs(this.node.current, "pointerdown", (a) =>
      this.onPointerDown(a),
    );
  }
  update() {
    this.session && this.session.updateHandlers(this.createPanHandlers());
  }
  unmount() {
    this.removePointerDownListener(), this.session && this.session.end();
  }
}
let yc = !1;
class sA extends U.Component {
  componentDidMount() {
    const {
        visualElement: a,
        layoutGroup: r,
        switchLayoutGroup: l,
        layoutId: c,
      } = this.props,
      { projection: d } = a;
    d &&
      (r.group && r.group.add(d),
      l && l.register && c && l.register(d),
      yc && d.root.didUpdate(),
      d.addEventListener("animationComplete", () => {
        this.safeToRemove();
      }),
      d.setOptions({
        ...d.options,
        layoutDependency: this.props.layoutDependency,
        onExitComplete: () => this.safeToRemove(),
      })),
      (fr.hasEverUpdated = !0);
  }
  getSnapshotBeforeUpdate(a) {
    const {
        layoutDependency: r,
        visualElement: l,
        drag: c,
        isPresent: d,
      } = this.props,
      { projection: f } = l;
    return (
      f &&
        ((f.isPresent = d),
        a.layoutDependency !== r &&
          f.setOptions({ ...f.options, layoutDependency: r }),
        (yc = !0),
        c || a.layoutDependency !== r || r === void 0 || a.isPresent !== d
          ? f.willUpdate()
          : this.safeToRemove(),
        a.isPresent !== d &&
          (d
            ? f.promote()
            : f.relegate() ||
              Et.postRender(() => {
                const m = f.getStack();
                (!m || !m.members.length) && this.safeToRemove();
              }))),
      null
    );
  }
  componentDidUpdate() {
    const { visualElement: a, layoutAnchor: r } = this.props,
      { projection: l } = a;
    l &&
      ((l.options.layoutAnchor = r),
      l.root.didUpdate(),
      uf.postRender(() => {
        !l.currentAnimation && l.isLead() && this.safeToRemove();
      }));
  }
  componentWillUnmount() {
    const {
        visualElement: a,
        layoutGroup: r,
        switchLayoutGroup: l,
      } = this.props,
      { projection: c } = a;
    (yc = !0),
      c &&
        (c.scheduleCheckAfterUnmount(),
        r && r.group && r.group.remove(c),
        l && l.deregister && l.deregister(c));
  }
  safeToRemove() {
    const { safeToRemove: a } = this.props;
    a && a();
  }
  render() {
    return null;
  }
}
function O0(i) {
  const [a, r] = p0(),
    l = U.useContext(Ss);
  return S.jsx(sA, {
    ...i,
    layoutGroup: l,
    switchLayoutGroup: U.useContext(E0),
    isPresent: a,
    safeToRemove: r,
  });
}
const lA = {
  pan: { Feature: aA },
  drag: { Feature: iA, ProjectionNode: m0, MeasureLayout: O0 },
};
function zy(i, a, r) {
  const { props: l } = i;
  i.animationState &&
    l.whileHover &&
    i.animationState.setActive("whileHover", r === "Start");
  const c = "onHover" + r,
    d = l[c];
  d && Et.postRender(() => d(a, Cs(a)));
}
class rA extends kn {
  mount() {
    const { current: a } = this.node;
    a &&
      (this.unmount = Ab(
        a,
        (r, l) => (zy(this.node, l, "Start"), (c) => zy(this.node, c, "End")),
      ));
  }
  unmount() {}
}
class oA extends kn {
  constructor() {
    super(...arguments), (this.isActive = !1);
  }
  onFocus() {
    let a = !1;
    try {
      a = this.node.current.matches(":focus-visible");
    } catch {
      a = !0;
    }
    !a ||
      !this.node.animationState ||
      (this.node.animationState.setActive("whileFocus", !0),
      (this.isActive = !0));
  }
  onBlur() {
    !this.isActive ||
      !this.node.animationState ||
      (this.node.animationState.setActive("whileFocus", !1),
      (this.isActive = !1));
  }
  mount() {
    this.unmount = Ms(
      Es(this.node.current, "focus", () => this.onFocus()),
      Es(this.node.current, "blur", () => this.onBlur()),
    );
  }
  unmount() {}
}
function Uy(i, a, r) {
  const { props: l } = i;
  if (i.current instanceof HTMLButtonElement && i.current.disabled) return;
  i.animationState &&
    l.whileTap &&
    i.animationState.setActive("whileTap", r === "Start");
  const c = "onTap" + (r === "End" ? "" : r),
    d = l[c];
  d && Et.postRender(() => d(a, Cs(a)));
}
class uA extends kn {
  mount() {
    const { current: a } = this.node;
    if (!a) return;
    const { globalTapTarget: r, propagate: l } = this.node.props;
    this.unmount = jb(
      a,
      (c, d) => (
        Uy(this.node, d, "Start"),
        (f, { success: m }) => Uy(this.node, f, m ? "End" : "Cancel")
      ),
      { useGlobalTarget: r, stopPropagation: l?.tap === !1 },
    );
  }
  unmount() {}
}
const Yc = new WeakMap(),
  gc = new WeakMap(),
  cA = (i) => {
    const a = Yc.get(i.target);
    a && a(i);
  },
  fA = (i) => {
    i.forEach(cA);
  };
function dA({ root: i, ...a }) {
  const r = i || document;
  gc.has(r) || gc.set(r, {});
  const l = gc.get(r),
    c = JSON.stringify(a);
  return l[c] || (l[c] = new IntersectionObserver(fA, { root: i, ...a })), l[c];
}
function hA(i, a, r) {
  const l = dA(a);
  return (
    Yc.set(i, r),
    l.observe(i),
    () => {
      Yc.delete(i), l.unobserve(i);
    }
  );
}
const mA = { some: 0, all: 1 };
class pA extends kn {
  constructor() {
    super(...arguments), (this.hasEnteredView = !1), (this.isInView = !1);
  }
  startObserver() {
    this.stopObserver?.();
    const { viewport: a = {} } = this.node.getProps(),
      { root: r, margin: l, amount: c = "some", once: d } = a,
      f = {
        root: r ? r.current : void 0,
        rootMargin: l,
        threshold: typeof c == "number" ? c : mA[c],
      },
      m = (y) => {
        const { isIntersecting: p } = y;
        if (
          this.isInView === p ||
          ((this.isInView = p), d && !p && this.hasEnteredView)
        )
          return;
        p && (this.hasEnteredView = !0),
          this.node.animationState &&
            this.node.animationState.setActive("whileInView", p);
        const { onViewportEnter: g, onViewportLeave: x } = this.node.getProps(),
          b = p ? g : x;
        b && b(y);
      };
    this.stopObserver = hA(this.node.current, f, m);
  }
  mount() {
    this.startObserver();
  }
  update() {
    if (typeof IntersectionObserver > "u") return;
    const { props: a, prevProps: r } = this.node;
    ["amount", "margin", "root"].some(yA(a, r)) && this.startObserver();
  }
  unmount() {
    this.stopObserver?.(), (this.hasEnteredView = !1), (this.isInView = !1);
  }
}
function yA({ viewport: i = {} }, { viewport: a = {} } = {}) {
  return (r) => i[r] !== a[r];
}
const gA = {
    inView: { Feature: pA },
    tap: { Feature: uA },
    focus: { Feature: oA },
    hover: { Feature: rA },
  },
  vA = { layout: { ProjectionNode: m0, MeasureLayout: O0 } },
  SA = { ...qE, ...gA, ...lA, ...vA },
  St = UE(SA, BE);
function By(i) {
  const a = Er(() => gi(i)),
    { isStatic: r } = U.useContext(Os);
  if (r) {
    const [, l] = U.useState(i);
    U.useEffect(() => a.on("change", l), []);
  }
  return a;
}
function xA(i) {
  const a = U.useRef(0),
    { isStatic: r } = U.useContext(Os);
  U.useEffect(() => {
    if (r) return;
    const l = ({ timestamp: c, delta: d }) => {
      a.current || (a.current = c), i(c - a.current, d);
    };
    return Et.update(l, !0), () => pn(l);
  }, [i]);
}
function js() {
  !mf.current && Zg();
  const [i] = U.useState(vr.current);
  return i;
}
function C0(i) {
  return i.order.map((a) => i.objects[a]).filter(Boolean);
}
function mi(i, a) {
  return C0(i).filter((r) => r.type === a);
}
function Ns(i) {
  const a = C0(i);
  return (
    a.find((r) => r.role === "primary") ??
    a.find((r) => !["metric", "progress", "note"].includes(r.type)) ??
    null
  );
}
function bA(i) {
  const a = Ns(i);
  return a
    ? a.type === "message"
      ? "conversation"
      : a.type === "chart"
        ? "training"
        : a.type === "diagram"
          ? "architecture"
          : a.type === "document"
            ? "document"
            : a.type === "code"
              ? "code"
              : "idle"
    : "idle";
}
const Nr = {
    chart: (i) => i,
    metric: (i) => i,
    progress: (i) => i,
    diagram: (i) => i,
    document: (i) => i,
    code: (i) => i,
    message: (i) => i,
    note: (i) => i,
  },
  TA = ["show", "hide", "say", "focus", "listen", "clear"];
function j0() {
  return {
    objects: {},
    order: [],
    speech: null,
    listening: !1,
    focusId: null,
    revision: 0,
  };
}
function EA(i, a) {
  const r = i.revision + 1,
    l = Date.now();
  switch (a.op) {
    case "show": {
      if (!a.id || !a.type) return i;
      const c = i.objects[a.id],
        d = {
          id: a.id,
          type: a.type,
          role: a.role ?? c?.role,
          data: a.data,
          createdAt: c?.createdAt ?? l,
          updatedAt: l,
        };
      return {
        ...i,
        objects: { ...i.objects, [a.id]: d },
        order: c ? i.order : [...i.order, a.id],
        revision: r,
      };
    }
    case "hide": {
      if (!i.objects[a.id]) return i;
      const c = { ...i.objects };
      return (
        delete c[a.id],
        {
          ...i,
          objects: c,
          order: i.order.filter((d) => d !== a.id),
          speech: i.speech?.target === a.id ? null : i.speech,
          focusId: i.focusId === a.id ? null : i.focusId,
          revision: r,
        }
      );
    }
    case "say":
      return {
        ...i,
        speech: { text: a.text, target: a.target ?? null, at: a.at ?? null },
        revision: r,
      };
    case "focus":
      return {
        ...i,
        focusId: a.id && i.objects[a.id] ? a.id : null,
        revision: r,
      };
    case "listen":
      return { ...i, listening: a.on, revision: r };
    case "clear":
      return { ...j0(), revision: r };
    default:
      return a;
  }
}
const N0 = {
    xLabel: "EPOCH",
    yLabel: "LOSS",
    xMax: 40,
    yMin: 0.08,
    yMax: 0.3,
    marker: { x: 32, series: "VAL LOSS" },
    series: [
      {
        name: "TRAIN LOSS",
        semantic: "green",
        values: [
          0.277, 0.262, 0.249, 0.236, 0.225, 0.214, 0.204, 0.195, 0.186, 0.178,
          0.17, 0.162, 0.155, 0.148, 0.142, 0.136, 0.131, 0.126, 0.121, 0.117,
          0.113, 0.11, 0.108, 0.106, 0.105, 0.1041,
        ],
      },
      {
        name: "VAL LOSS",
        semantic: "orange",
        values: [
          0.284, 0.269, 0.254, 0.24, 0.227, 0.216, 0.206, 0.197, 0.189, 0.181,
          0.175, 0.169, 0.164, 0.159, 0.155, 0.152, 0.15, 0.151, 0.154, 0.158,
          0.164, 0.171, 0.179, 0.188, 0.197, 0.1832,
        ],
      },
    ],
  },
  AA = {
    idle: [],
    conversation: [
      {
        op: "show",
        id: "message",
        type: "message",
        role: "primary",
        data: {
          context: "TRAINING DISCUSSION",
          tag: "CURRENT RESPONSE / 01",
          segments: [
            { text: "The divergence begins around " },
            { text: "epoch 32", accent: !0 },
            {
              text: ". Training loss keeps falling, but validation loss turns upward, so I would inspect the learning-rate transition and the first batches after it.",
            },
          ],
          channel: { name: "VOICE", mode: "HANDS-FREE" },
          transcript: [
            { speaker: "YOU", text: "How did the training run go?" },
            {
              speaker: "DAMOCLES",
              text: "The run is still healthy overall, but validation divergence begins around epoch 32.",
            },
            { speaker: "YOU", text: "What would you check first?" },
            {
              speaker: "DAMOCLES",
              text: "I would inspect the learning-rate transition and the first batches immediately after it. The training curve itself is still descending normally.",
            },
          ],
        },
      },
    ],
    training: [
      {
        op: "show",
        id: "loss",
        type: "chart",
        role: "primary",
        data: {
          ...N0,
          title: "RUN / GRAPE-AMODAL-04",
          subtitle: "TRAINING / LOSS TRACE / LIVE",
          context: "TRAINING RUN",
        },
      },
      {
        op: "show",
        id: "val-loss",
        type: "metric",
        data: { label: "VAL LOSS", value: "0.1832", semantic: "orange" },
      },
      {
        op: "show",
        id: "train-loss",
        type: "metric",
        data: { label: "TRAIN LOSS", value: "0.1041", semantic: "green" },
      },
      {
        op: "show",
        id: "learning-rate",
        type: "metric",
        data: { label: "LEARNING RATE", value: "1.2e-4" },
      },
      {
        op: "show",
        id: "gpu",
        type: "metric",
        data: { label: "GPU", value: "91%" },
      },
      {
        op: "show",
        id: "eta",
        type: "metric",
        data: { label: "ETA", value: "01:42:18" },
      },
      {
        op: "show",
        id: "progress",
        type: "progress",
        data: {
          label: "EPOCH 41 / 80",
          detail: "ACTIVE / OPTIMIZER STEP 18442",
          value: 0.5125,
          text: "51.25% COMPLETE",
        },
      },
      {
        op: "show",
        id: "training-note",
        type: "note",
        data: {
          tag: "OBSERVATION / EPOCH 32+",
          segments: [
            {
              text: "Validation loss turns upward here while training loss continues down. I would inspect the ",
            },
            { text: "learning-rate transition", accent: !0, bold: !0 },
            { text: " and the first batches after it." },
          ],
        },
      },
    ],
    architecture: [
      {
        op: "show",
        id: "system-map",
        type: "diagram",
        role: "primary",
        data: {
          title: "SYSTEM / CONTROL TRANSFER",
          subtitle: "SWITCHBOARD -> PROJECT SESSION / ROUTING TRACE",
          context: "SYSTEM MAP",
          nodes: [
            {
              id: "damocles",
              label: "DAMOCLES",
              sub: "FRONT DESK / OPERATOR",
              detail: "CONTEXT / GENERAL",
              semantic: "orange",
            },
            {
              id: "session",
              label: "PROJECT SESSION",
              sub: "HEADLESS PI / SSH",
              detail: "CONTEXT / SWITCHBOARD",
              semantic: "paper",
            },
            {
              id: "planner",
              label: "PLANNER",
              sub: "PLAN IR / GENERATE",
              semantic: "green",
            },
            {
              id: "implementer",
              label: "IMPLEMENTER",
              sub: "PATCH / EXECUTE",
              semantic: "cyan",
            },
            {
              id: "pool",
              label: "SUBAGENT POOL",
              sub: "DELEGATED EXECUTION / PARALLEL",
              semantic: "paper",
            },
          ],
          edges: [
            { from: "damocles", to: "session", semantic: "orange", active: !0 },
            { from: "session", to: "planner", semantic: "orange", active: !0 },
            { from: "session", to: "implementer", semantic: "orange" },
            { from: "planner", to: "pool", semantic: "green" },
            { from: "implementer", to: "pool", semantic: "cyan" },
          ],
        },
      },
      {
        op: "show",
        id: "architecture-note",
        type: "note",
        data: {
          tag: "CURRENT EXPLANATION / 01",
          segments: [
            { text: "The voice does not change. " },
            { text: "Context moves.", accent: !0, bold: !0 },
            {
              text: " Damocles routes the session into the project directory, then the project orchestrator delegates work without exposing those internal handoffs to you.",
            },
          ],
        },
      },
    ],
    email: [
      {
        op: "show",
        id: "mail",
        type: "document",
        role: "primary",
        data: {
          kind: "email",
          context: "MAIL",
          source: "MAIL / INBOX",
          from: "PROF. ARDEN",
          timestamp: "23 AUG 2026 / 01:14",
          subject: "Re: revised segmentation results and September submission",
          paragraphs: [
            "Kayne,",
            "I reviewed the new figures. The hidden-region results are much easier to follow now, and I agree that the residual correction should stay framed as a lightweight final-stage adjustment rather than a second model.",
            "Please send me the updated draft once you have the new seed runs in place. I would also tighten the related-work paragraph before submission.",
            `Best,
Arden`,
          ],
        },
      },
      {
        op: "show",
        id: "email-note",
        type: "note",
        data: {
          tag: "DAMOCLES / SUMMARY",
          segments: [
            {
              text: "No action is required immediately. The only concrete request is to send the updated draft after the additional seed runs and tighten related work before submission.",
            },
          ],
        },
      },
    ],
    code: [
      {
        op: "show",
        id: "source",
        type: "code",
        role: "primary",
        data: {
          title: "SOURCE / ROUTER",
          file: "apps/backend/src/session/router.ts / L41-57",
          context: "CODE REVIEW",
          source: {
            language: "typescript",
            highlight: [5, 6, 7, 8, 9, 10, 11],
            text: `export async function routeSession(request: RouteRequest) {
  const project = await resolveProject(request.project);
  const target = project.session ?? await createSession(project);

  if (request.mode === "coding") {
    await handoffContext({
      source: request.context,
      destination: target,
      preserveVoice: true,
    });
  }

  return attachTransport(target, {
    ssh: project.host,
    cwd: project.path,
  });
}`,
          },
        },
      },
      {
        op: "show",
        id: "code-note",
        type: "note",
        data: {
          tag: "DAMOCLES / L45-51",
          segments: [
            { text: "This is the actual handoff boundary. " },
            {
              text: "The executor changes; the voice does not.",
              accent: !0,
              bold: !0,
            },
            { text: " The rest of the function is transport plumbing." },
          ],
        },
      },
    ],
  },
  Hy = {
    op: "show",
    id: "previous-run",
    type: "chart",
    role: "compare",
    data: {
      ...N0,
      title: "RUN / GRAPE-AMODAL-03",
      subtitle: "COMPARISON / PREVIOUS",
      context: "TRAINING RUN",
      compareLabel: "PREVIOUS",
      marker: void 0,
      series: [
        {
          name: "VAL LOSS",
          semantic: "cyan",
          values: [
            0.292, 0.278, 0.263, 0.249, 0.237, 0.226, 0.216, 0.207, 0.199,
            0.192, 0.186, 0.181, 0.177, 0.174, 0.172, 0.171, 0.172, 0.174,
            0.177, 0.181, 0.186, 0.192, 0.199, 0.207, 0.216, 0.224,
          ],
        },
      ],
    },
  },
  w0 = U.createContext(null);
function MA({ children: i }) {
  const [a, r] = U.useReducer(EA, void 0, j0),
    [l, c] = U.useState("idle"),
    [d, f] = U.useState(!1),
    [m, y] = U.useState(null),
    p = U.useCallback((j) => {
      y(j);
    }, []),
    g = U.useCallback((j) => {
      for (const A of j) r(A);
    }, []),
    x = U.useCallback((j) => {
      r({ op: "clear" }), f(!1), c(j);
      for (const A of AA[j]) r(A);
    }, []),
    b = U.useMemo(
      () => ({
        state: a,
        dispatch: r,
        run: g,
        loadFixture: x,
        fixture: l,
        transcriptOpen: d,
        setTranscriptOpen: f,
        voiceRuntime: m,
        registerVoiceRuntime: p,
      }),
      [a, g, x, l, d, m, p],
    );
  return S.jsx(w0.Provider, { value: b, children: i });
}
function ws() {
  const i = U.useContext(w0);
  if (!i)
    throw new Error("useController must be used inside ControllerProvider");
  return i;
}
function V0({ segments: i }) {
  return S.jsx(S.Fragment, {
    children: i.map((a, r) => {
      const l = [
          a.accent ? "accent" : "",
          a.semantic ? `semantic-${a.semantic}` : "",
        ]
          .filter(Boolean)
          .join(" "),
        c = a.bold ? S.jsx("strong", { children: a.text }) : a.text;
      return S.jsx(
        "span",
        { className: l || void 0, children: c },
        `${r}-${a.text.slice(0, 12)}`,
      );
    }),
  });
}
function Vs({ data: i, onFocus: a }) {
  const r = S.jsxs(S.Fragment, {
    children: [
      S.jsx("div", {
        className: "annotation-card__tag tech micro",
        children: i.tag ?? "DAMOCLES / EXPLANATION",
      }),
      S.jsx("div", {
        className: "annotation-card__text",
        children: S.jsx(V0, { segments: i.segments }),
      }),
    ],
  });
  return a
    ? S.jsx(St.button, {
        type: "button",
        className: "annotation-card annotation-card--button",
        onClick: a,
        whileHover: { x: 1 },
        "aria-label": "Expand explanation",
        children: r,
      })
    : S.jsx("div", { className: "annotation-card", children: r });
}
const Gy = {
  red: "var(--red)",
  orange: "var(--orange)",
  green: "var(--green)",
  cyan: "var(--cyan)",
  amber: "var(--amber)",
  paper: "var(--paper)",
  muted: "var(--muted)",
};
function RA(i, a, r = 4) {
  return Array.from({ length: r }, (l, c) => a - ((a - i) * c) / (r - 1));
}
function _0({ data: i, focused: a = !1 }) {
  const r = js(),
    l = U.useId().replace(/:/g, ""),
    c = 1e3,
    d = 500,
    f = { left: 74, right: 28, top: 34, bottom: 54 },
    m = i.yMin ?? Math.min(...i.series.flatMap((_) => _.values)),
    y = i.yMax ?? Math.max(...i.series.flatMap((_) => _.values)),
    p = Math.max(2, ...i.series.map((_) => _.values.length)),
    g = i.xMax ?? p - 1,
    x = (_) => f.left + (_ / g) * (c - f.left - f.right),
    b = (_, H) => f.left + (_ / Math.max(1, H - 1)) * (c - f.left - f.right),
    j = (_) =>
      f.top + (1 - (_ - m) / Math.max(1e-6, y - m)) * (d - f.top - f.bottom),
    A = U.useMemo(
      () =>
        i.series.map((_) => ({
          ..._,
          path: _.values
            .map(
              (H, X) =>
                `${X === 0 ? "M" : "L"} ${b(X, _.values.length).toFixed(2)} ${j(H).toFixed(2)}`,
            )
            .join(" "),
        })),
      [i.series, m, y],
    ),
    R = i.marker
      ? (i.series.find((_) => _.name === i.marker?.series) ?? i.series[0])
      : void 0,
    V =
      i.marker && R
        ? Math.round((i.marker.x / g) * Math.max(0, R.values.length - 1))
        : 0,
    L = R?.values[Math.min((R?.values.length ?? 1) - 1, V)];
  return S.jsx("div", {
    className: `chart-primitive${a ? " chart-primitive--focused" : ""}`,
    "data-testid": "chart",
    children: S.jsxs("svg", {
      viewBox: `0 0 ${c} ${d}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": i.title ?? "Chart",
      children: [
        S.jsx("defs", {
          children: S.jsx("clipPath", {
            id: l,
            children: S.jsx("rect", {
              x: f.left,
              y: f.top,
              width: c - f.left - f.right,
              height: d - f.top - f.bottom,
            }),
          }),
        }),
        S.jsxs("g", {
          className: "chart-grid",
          children: [
            RA(m, y).map((_) =>
              S.jsxs(
                "g",
                {
                  children: [
                    S.jsx("line", {
                      x1: f.left,
                      y1: j(_),
                      x2: c - f.right,
                      y2: j(_),
                    }),
                    S.jsx("text", {
                      x: f.left - 14,
                      y: j(_) + 4,
                      textAnchor: "end",
                      children: _.toFixed(2),
                    }),
                  ],
                },
                _,
              ),
            ),
            [0, 0.25, 0.5, 0.75, 1].map((_) => {
              const H = f.left + _ * (c - f.left - f.right);
              return S.jsxs(
                "g",
                {
                  children: [
                    S.jsx("line", {
                      x1: H,
                      y1: f.top,
                      x2: H,
                      y2: d - f.bottom,
                    }),
                    S.jsx("text", {
                      x: H,
                      y: d - 20,
                      textAnchor: "middle",
                      children: Math.round(_ * g),
                    }),
                  ],
                },
                _,
              );
            }),
          ],
        }),
        S.jsxs("g", {
          clipPath: `url(#${l})`,
          children: [
            A.map((_, H) =>
              S.jsx(
                St.path,
                {
                  d: _.path,
                  fill: "none",
                  stroke: Gy[_.semantic ?? (H === 0 ? "green" : "orange")],
                  strokeWidth: a ? 3 : 2.3,
                  vectorEffect: "non-scaling-stroke",
                  initial: r ? void 0 : { pathLength: 0, opacity: 0 },
                  animate: { pathLength: 1, opacity: 1 },
                  transition: {
                    duration: 0.62,
                    delay: H * 0.08,
                    ease: [0.22, 0.61, 0.36, 1],
                  },
                },
                _.name,
              ),
            ),
            i.marker && L != null
              ? S.jsxs(St.g, {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  transition: { delay: 0.42 },
                  children: [
                    S.jsx("line", {
                      x1: x(i.marker.x),
                      y1: f.top,
                      x2: x(i.marker.x),
                      y2: d - f.bottom,
                      stroke: "rgba(var(--orange-rgb),.34)",
                      strokeDasharray: "6 8",
                    }),
                    S.jsx("circle", {
                      cx: x(i.marker.x),
                      cy: j(L),
                      r: a ? 7 : 5,
                      fill: "#000",
                      stroke: "var(--orange)",
                      strokeWidth: "2",
                    }),
                  ],
                })
              : null,
          ],
        }),
        S.jsx("text", {
          className: "chart-axis-label",
          x: c / 2,
          y: d - 2,
          textAnchor: "middle",
          children: i.xLabel ?? "X",
        }),
        S.jsx("text", {
          className: "chart-axis-label",
          transform: `translate(17 ${d / 2}) rotate(-90)`,
          textAnchor: "middle",
          children: i.yLabel ?? "Y",
        }),
        S.jsx("g", {
          className: "chart-legend",
          transform: `translate(${f.left + 8} ${f.top + 12})`,
          children: i.series.map((_, H) =>
            S.jsxs(
              "g",
              {
                transform: `translate(${H * 178} 0)`,
                children: [
                  S.jsx("line", {
                    x1: "0",
                    y1: "0",
                    x2: "24",
                    y2: "0",
                    stroke: Gy[_.semantic ?? "paper"],
                    strokeWidth: "2",
                  }),
                  S.jsx("text", { x: "34", y: "4", children: _.name }),
                ],
              },
              _.name,
            ),
          ),
        }),
      ],
    }),
  });
}
const DA = {
  panel: "M 2 26 L 2 2 L 912 2 L 998 62 L 998 498 L 58 498 L 2 442 Z",
  document: "M 2 20 L 2 2 L 940 2 L 998 60 L 998 498 L 78 498 L 2 432 Z",
  code: "M 2 46 L 2 2 L 850 2 L 910 48 L 998 48 L 998 498 L 155 498 L 102 450 L 2 450 Z",
  open: "M 2 120 L 2 2 L 350 2 M 650 2 L 998 2 L 998 170 M 998 330 L 998 498 L 690 498 M 310 498 L 2 498 L 2 380",
};
function _s({ variant: i = "panel", className: a }) {
  const r = js();
  return S.jsxs("svg", {
    className: `tech-frame ${a ?? ""}`,
    viewBox: "0 0 1000 500",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
    children: [
      S.jsx(St.path, {
        d: DA[i],
        fill: "none",
        stroke: "rgba(var(--orange-rgb), .58)",
        strokeWidth: "1.25",
        vectorEffect: "non-scaling-stroke",
        initial: r ? void 0 : { pathLength: 0, opacity: 0 },
        animate: { pathLength: 1, opacity: 1 },
        exit: r ? void 0 : { pathLength: 0, opacity: 0 },
        transition: { duration: 0.36, ease: [0.22, 0.61, 0.36, 1] },
      }),
      S.jsx("path", {
        d: "M 2 78 L 2 142 M 998 94 L 998 166 M 928 498 L 984 498",
        fill: "none",
        stroke: "rgba(232,230,223,.18)",
        strokeWidth: "1",
        vectorEffect: "non-scaling-stroke",
      }),
    ],
  });
}
const OA =
    /\b(export|async|function|const|let|var|if|else|return|await|new|true|false|null|undefined|type|interface|class|extends|import|from)\b/g,
  CA = /\b([A-Z][A-Za-z0-9_]*)\b/g,
  jA = /\b(\d+(?:\.\d+)?)\b/g,
  NA = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
function Yy(i, a) {
  const r = [];
  let l = 0;
  const c = [];
  for (const f of i.matchAll(OA))
    c.push({
      start: f.index,
      end: f.index + f[0].length,
      className: "tok-keyword",
    });
  for (const f of i.matchAll(CA))
    c.push({
      start: f.index,
      end: f.index + f[0].length,
      className: "tok-type",
    });
  for (const f of i.matchAll(jA))
    c.push({
      start: f.index,
      end: f.index + f[0].length,
      className: "tok-number",
    });
  c.sort((f, m) => f.start - m.start || m.end - f.end);
  let d = -1;
  for (const f of c)
    f.start < d ||
      (f.start > l && r.push(i.slice(l, f.start)),
      r.push(
        S.jsx(
          "span",
          { className: f.className, children: i.slice(f.start, f.end) },
          `${a}-${f.start}`,
        ),
      ),
      (l = f.end),
      (d = f.end));
  return l < i.length && r.push(i.slice(l)), r;
}
function wA(i, a) {
  const r = i.indexOf("//"),
    l = r >= 0 ? i.slice(0, r) : i,
    c = r >= 0 ? i.slice(r) : "",
    d = [];
  let f = 0;
  for (const m of l.matchAll(NA)) {
    const y = m.index;
    y > f && d.push(...Yy(l.slice(f, y), `${a}-${f}`)),
      d.push(
        S.jsx(
          "span",
          { className: "tok-string", children: m[0] },
          `${a}-str-${y}`,
        ),
      ),
      (f = y + m[0].length);
  }
  return (
    f < l.length && d.push(...Yy(l.slice(f), `${a}-${f}`)),
    c &&
      d.push(
        S.jsx(
          "span",
          { className: "tok-comment", children: c },
          `${a}-comment`,
        ),
      ),
    d
  );
}
function L0({ data: i, focused: a = !1 }) {
  const r = i.source.text.split(`
`),
    l = new Set(i.source.highlight ?? []);
  return S.jsxs("div", {
    className: `code-viewport${a ? " code-viewport--focused" : ""}`,
    "data-testid": "code",
    children: [
      S.jsx(_s, { variant: "code" }),
      S.jsx("div", {
        className: "code-viewport__mask",
        children: S.jsx("div", {
          className: "code-viewport__scroll",
          tabIndex: 0,
          children: S.jsx("pre", {
            children: r.map((c, d) => {
              const f = d + 1;
              return S.jsxs(
                "span",
                {
                  className: `code-line${l.has(f) ? " code-line--hot" : ""}`,
                  children: [
                    S.jsx("span", {
                      className: "code-line__number",
                      children: f,
                    }),
                    S.jsx("span", {
                      className: "code-line__source",
                      children: wA(c, d),
                    }),
                  ],
                },
                f,
              );
            }),
          }),
        }),
      }),
    ],
  });
}
const VA = "modulepreload",
  _A = function (i) {
    return "/" + i;
  },
  qy = {},
  LA = function (a, r, l) {
    let c = Promise.resolve();
    if (r && r.length > 0) {
      let y = function (p) {
        return Promise.all(
          p.map((g) =>
            Promise.resolve(g).then(
              (x) => ({ status: "fulfilled", value: x }),
              (x) => ({ status: "rejected", reason: x }),
            ),
          ),
        );
      };
      document.getElementsByTagName("link");
      const f = document.querySelector("meta[property=csp-nonce]"),
        m = f?.nonce || f?.getAttribute("nonce");
      c = y(
        r.map((p) => {
          if (((p = _A(p)), p in qy)) return;
          qy[p] = !0;
          const g = p.endsWith(".css"),
            x = g ? '[rel="stylesheet"]' : "";
          if (document.querySelector(`link[href="${p}"]${x}`)) return;
          const b = document.createElement("link");
          if (
            ((b.rel = g ? "stylesheet" : VA),
            g || (b.as = "script"),
            (b.crossOrigin = ""),
            (b.href = p),
            m && b.setAttribute("nonce", m),
            document.head.appendChild(b),
            g)
          )
            return new Promise((j, A) => {
              b.addEventListener("load", j),
                b.addEventListener("error", () =>
                  A(new Error(`Unable to preload CSS for ${p}`)),
                );
            });
        }),
      );
    }
    function d(f) {
      const m = new Event("vite:preloadError", { cancelable: !0 });
      if (((m.payload = f), window.dispatchEvent(m), !m.defaultPrevented))
        throw f;
    }
    return c.then((f) => {
      for (const m of f || []) m.status === "rejected" && d(m.reason);
      return a().catch(d);
    });
  };
function zA(i) {
  const [a, r] = U.useState({ width: 0, height: 0 });
  return (
    U.useEffect(() => {
      const l = i.current;
      if (!l) return;
      const c = () => {
        const f = l.getBoundingClientRect();
        r({ width: f.width, height: f.height });
      };
      c();
      const d = new ResizeObserver(c);
      return d.observe(l), () => d.disconnect();
    }, [i]),
    a
  );
}
const Xy = {
  red: "var(--red)",
  orange: "var(--orange)",
  green: "var(--green)",
  cyan: "var(--cyan)",
  amber: "var(--amber)",
  paper: "var(--paper)",
  muted: "var(--muted)",
};
let UA = 0;
function BA({ data: i, focused: a }) {
  const r = U.useRef(null),
    [l, c] = U.useState("");
  return (
    U.useEffect(() => {
      const d = r.current,
        f = i.source?.trim();
      if (!d || !f) return;
      let m = !0;
      const y = getComputedStyle(document.documentElement),
        p = (x, b) => y.getPropertyValue(x).trim() || b;
      return (
        (async () => {
          try {
            const { default: x } = await LA(async () => {
              const { default: _ } = await import(
                "./mermaid.core-CSrxr0DU.js"
              ).then((H) => H.cc);
              return { default: _ };
            }, []);
            x.initialize({
              startOnLoad: !1,
              theme: "base",
              securityLevel: "antiscript",
              flowchart: { htmlLabels: !0, curve: "basis", useMaxWidth: !0 },
              themeVariables: {
                darkMode: !0,
                background: "#000000",
                primaryColor: "#000000",
                primaryBorderColor: p("--paper", "#ece8df"),
                primaryTextColor: p("--paper", "#ece8df"),
                secondaryColor: "#080808",
                tertiaryColor: "#000000",
                lineColor: p("--cyan", "#65d7e8"),
                textColor: p("--paper", "#ece8df"),
                edgeLabelBackground: "#000000",
                fontFamily: "IBM Plex Mono, ui-monospace, monospace",
                fontSize: "14px",
              },
            });
            const b = `switchboard-mermaid-${++UA}`;
            if (!(await x.parse(f, { suppressErrors: !0 })))
              throw new Error("Mermaid source did not parse");
            const A = await x.render(b, f);
            if (!m || !r.current) return;
            const R = new DOMParser().parseFromString(A.svg, "image/svg+xml");
            if (R.querySelector("parsererror"))
              throw new Error("Rendered SVG did not parse");
            const L = document.adoptNode(R.documentElement);
            L.setAttribute("role", "img"),
              L.setAttribute("aria-label", i.title ?? "System diagram"),
              r.current.replaceChildren(L),
              A.bindFunctions?.(r.current),
              c("");
          } catch (x) {
            if (!m) return;
            d.replaceChildren(), c(x instanceof Error ? x.message : String(x));
          }
        })(),
        () => {
          m = !1;
        }
      );
    }, [i.source, i.title]),
    S.jsxs("div", {
      className: `diagram-primitive diagram-primitive--mermaid${a ? " diagram-primitive--focused" : ""}`,
      "data-testid": "diagram",
      children: [
        S.jsx("div", { ref: r, className: "diagram-primitive__mermaid" }),
        l
          ? S.jsxs("div", {
              className: "diagram-primitive__error tech micro",
              children: ["DIAGRAM FAULT / ", l],
            })
          : null,
      ],
    })
  );
}
function HA(i, a) {
  const r = new Map(i.map((y) => [y.id, 0])),
    l = new Map(i.map((y) => [y.id, []]));
  for (const y of a)
    r.set(y.to, (r.get(y.to) ?? 0) + 1), l.get(y.from)?.push(y.to);
  const c = i.filter((y) => (r.get(y.id) ?? 0) === 0).map((y) => y.id),
    d = new Map(),
    f = c.map((y) => ({ id: y, depth: 0 }));
  for (; f.length; ) {
    const y = f.shift();
    if (!y) break;
    if (!((d.get(y.id) ?? -1) >= y.depth)) {
      d.set(y.id, y.depth);
      for (const p of l.get(y.id) ?? []) f.push({ id: p, depth: y.depth + 1 });
    }
  }
  for (const y of i) d.has(y.id) || d.set(y.id, 0);
  const m = Math.max(0, ...d.values());
  return Array.from({ length: m + 1 }, (y, p) =>
    i.filter((g) => d.get(g.id) === p),
  );
}
function GA(i, a, r, l, c) {
  if (r) {
    const y = i.y + c / 2,
      p = a.y - c / 2,
      g = (y + p) / 2;
    return `M ${i.x} ${y} V ${g} H ${a.x} V ${p}`;
  }
  const d = i.x + l / 2,
    f = a.x - l / 2,
    m = (d + f) / 2;
  return `M ${d} ${i.y} H ${m} V ${a.y} H ${f}`;
}
function YA({ data: i, focused: a }) {
  const r = U.useRef(null),
    l = zA(r),
    c = l.height > l.width * 1.05,
    d = js(),
    f = c ? { width: 700, height: 1e3 } : { width: 1e3, height: 620 },
    m = c ? 244 : 182,
    y = c ? 98 : 88,
    p = U.useMemo(() => HA(i.nodes, i.edges), [i.nodes, i.edges]),
    g = U.useMemo(() => {
      const b = [],
        j = c ? 110 : 112,
        A = (c ? f.height : f.width) - j * 2,
        R = p.length <= 1 ? 0 : A / (p.length - 1);
      return (
        p.forEach((V, L) => {
          const _ = c ? f.width : f.height,
            H = c ? 96 : 82,
            X = _ - H * 2,
            k = V.length <= 1 ? 0 : X / (V.length - 1);
          V.forEach((tt, et) => {
            const P = V.length === 1 ? _ / 2 : H + et * k;
            b.push({
              ...tt,
              layer: L,
              indexInLayer: et,
              x: c ? P : j + L * R,
              y: c ? j + L * R : P,
            });
          });
        }),
        b
      );
    }, [p, c, f.height, f.width]),
    x = new Map(g.map((b) => [b.id, b]));
  return S.jsx("div", {
    ref: r,
    className: `diagram-primitive${a ? " diagram-primitive--focused" : ""}`,
    "data-testid": "diagram",
    children: S.jsxs("svg", {
      viewBox: `0 0 ${f.width} ${f.height}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": i.title ?? "System diagram",
      children: [
        S.jsx("defs", {
          children: S.jsxs("filter", {
            id: "active-edge-glow",
            x: "-20%",
            y: "-20%",
            width: "140%",
            height: "140%",
            children: [
              S.jsx("feGaussianBlur", { stdDeviation: "2.2", result: "blur" }),
              S.jsxs("feMerge", {
                children: [
                  S.jsx("feMergeNode", { in: "blur" }),
                  S.jsx("feMergeNode", { in: "SourceGraphic" }),
                ],
              }),
            ],
          }),
        }),
        S.jsx("g", {
          className: "diagram-edges",
          children: i.edges.map((b, j) => {
            const A = x.get(b.from),
              R = x.get(b.to);
            if (!A || !R) return null;
            const V = Xy[b.semantic ?? "paper"],
              L = GA(A, R, c, m, y);
            return S.jsxs(
              "g",
              {
                children: [
                  S.jsx(St.path, {
                    d: L,
                    fill: "none",
                    stroke: V,
                    strokeOpacity: b.active ? 0.85 : 0.48,
                    strokeWidth: b.active ? 2 : 1.25,
                    strokeDasharray: b.active ? "10 8" : void 0,
                    vectorEffect: "non-scaling-stroke",
                    filter: b.active ? "url(#active-edge-glow)" : void 0,
                    initial: d ? void 0 : { pathLength: 0, opacity: 0 },
                    animate: {
                      pathLength: 1,
                      opacity: 1,
                      strokeDashoffset: b.active ? [0, -36] : 0,
                    },
                    transition: {
                      pathLength: { duration: 0.42, delay: j * 0.06 },
                      opacity: { duration: 0.2, delay: j * 0.06 },
                      strokeDashoffset: b.active
                        ? { duration: 2.2, ease: "linear", repeat: 1 / 0 }
                        : void 0,
                    },
                  }),
                  S.jsx("circle", {
                    cx: R.x,
                    cy: c ? R.y - y / 2 : R.y,
                    r: "3",
                    fill: V,
                    opacity: ".9",
                  }),
                ],
              },
              `${b.from}-${b.to}`,
            );
          }),
        }),
        S.jsx("g", {
          className: "diagram-nodes",
          children: g.map((b, j) => {
            const A = Xy[b.semantic ?? "paper"];
            return S.jsxs(
              St.g,
              {
                transform: `translate(${b.x - m / 2} ${b.y - y / 2})`,
                initial: d ? void 0 : { opacity: 0, scale: 0.94 },
                animate: { opacity: 1, scale: 1 },
                transition: { duration: 0.28, delay: 0.12 + j * 0.05 },
                children: [
                  S.jsx("path", {
                    d: `M 0 14 L 14 0 H ${m - 22} L ${m} 22 V ${y} H 18 L 0 ${y - 18} Z`,
                    fill: "#000",
                    stroke: A,
                    strokeOpacity: ".64",
                    strokeWidth: "1.3",
                    vectorEffect: "non-scaling-stroke",
                  }),
                  S.jsx("line", {
                    x1: "16",
                    y1: "39",
                    x2: m - 16,
                    y2: "39",
                    stroke: A,
                    strokeOpacity: ".23",
                    vectorEffect: "non-scaling-stroke",
                  }),
                  S.jsx("text", {
                    x: "18",
                    y: "28",
                    className: "diagram-node-label",
                    fill: A,
                    children: b.label,
                  }),
                  S.jsx("text", {
                    x: "18",
                    y: "58",
                    className: "diagram-node-sub",
                    children: b.sub,
                  }),
                  b.detail
                    ? S.jsx("text", {
                        x: "18",
                        y: "76",
                        className: "diagram-node-detail",
                        children: b.detail,
                      })
                    : null,
                ],
              },
              b.id,
            );
          }),
        }),
      ],
    }),
  });
}
function z0({ data: i, focused: a = !1 }) {
  return i.source
    ? S.jsx(BA, { data: i, focused: a })
    : S.jsx(YA, { data: i, focused: a });
}
function U0({ data: i, focused: a = !1 }) {
  return S.jsxs("div", {
    className: `document-viewport${a ? " document-viewport--focused" : ""}`,
    "data-testid": "document",
    children: [
      S.jsx(_s, { variant: "document" }),
      S.jsxs("div", {
        className: "document-viewport__inner",
        children: [
          S.jsxs("div", {
            className: "document-viewport__meta tech micro",
            children: [
              S.jsx("span", { children: i.source ?? "DOCUMENT" }),
              S.jsx("span", { children: i.from ? `FROM / ${i.from}` : "" }),
              S.jsx("span", { children: i.timestamp }),
            ],
          }),
          S.jsx("h1", { children: i.subject }),
          S.jsx("div", {
            className: "document-viewport__body",
            tabIndex: 0,
            children: i.paragraphs.map((r, l) => {
              const c = r.split(`
`);
              return S.jsx(
                "p",
                {
                  children: c.map((d, f) =>
                    S.jsxs(
                      "span",
                      {
                        children: [
                          d,
                          f < c.length - 1 ? S.jsx("br", {}) : null,
                        ],
                      },
                      f,
                    ),
                  ),
                },
                `${l}-${r.slice(0, 16)}`,
              );
            }),
          }),
        ],
      }),
    ],
  });
}
function B0({ metrics: i }) {
  return S.jsx(St.div, {
    className: "metrics",
    layout: !0,
    "data-testid": "metrics",
    children: S.jsx(fa, {
      mode: "popLayout",
      initial: !1,
      children: i.map((a) =>
        S.jsxs(
          St.div,
          {
            className: "metric-row",
            layout: !0,
            initial: { opacity: 0, x: 12, filter: "blur(5px)" },
            animate: { opacity: 1, x: 0, filter: "blur(0px)" },
            exit: { opacity: 0, x: 10, filter: "blur(5px)" },
            transition: { duration: 0.28, ease: [0.22, 0.61, 0.36, 1] },
            children: [
              S.jsx("span", {
                className: "metric-row__label tech micro",
                children: a.data.label,
              }),
              S.jsx(
                St.span,
                {
                  className: `metric-row__value semantic-${a.data.semantic ?? "paper"}`,
                  initial: { opacity: 0.35, y: -3 },
                  animate: { opacity: 1, y: 0 },
                  transition: { duration: 0.22 },
                  children: a.data.value,
                },
                `${a.id}-${a.data.value}`,
              ),
            ],
          },
          a.id,
        ),
      ),
    }),
  });
}
function H0({ data: i }) {
  const a = Math.min(1, Math.max(0, i.value));
  return S.jsxs("div", {
    className: "progress-primitive",
    "data-testid": "progress",
    children: [
      S.jsxs("div", {
        className: "progress-primitive__label",
        children: [
          S.jsx("strong", { children: i.label }),
          S.jsx("span", { className: "tech micro muted", children: i.detail }),
        ],
      }),
      S.jsx("div", {
        className: "progress-primitive__track",
        "aria-label": i.text ?? `${Math.round(a * 100)} percent`,
        children: S.jsx(St.div, {
          className: "progress-primitive__fill",
          initial: { scaleX: 0 },
          animate: { scaleX: a },
          transition: { duration: 0.54, ease: [0.22, 0.61, 0.36, 1] },
        }),
      }),
      S.jsx("div", {
        className: "progress-primitive__text tech micro",
        children: i.text ?? `${Math.round(a * 100)}% COMPLETE`,
      }),
    ],
  });
}
function qA({ object: i }) {
  switch (i.type) {
    case "chart":
      return S.jsx(_0, { data: i.data, focused: !0 });
    case "diagram":
      return S.jsx(z0, { data: i.data, focused: !0 });
    case "document":
      return S.jsx(U0, { data: i.data, focused: !0 });
    case "code":
      return S.jsx(L0, { data: i.data, focused: !0 });
    case "note":
      return S.jsx(Vs, { data: i.data });
    case "metric":
      return S.jsx(B0, { metrics: [i] });
    case "progress":
      return S.jsx(H0, { data: i.data });
    default:
      return null;
  }
}
function XA({ object: i, onClose: a }) {
  return S.jsx(fa, {
    children: i
      ? S.jsx(St.div, {
          className: "focus-layer",
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          exit: { opacity: 0 },
          transition: { duration: 0.22 },
          role: "dialog",
          "aria-modal": "true",
          "aria-label": `Focused ${i.type}`,
          onMouseDown: (r) => {
            r.target === r.currentTarget && a();
          },
          children: S.jsxs(St.div, {
            className: `focus-layer__content focus-layer__content--${i.type}`,
            layoutId: `switchboard-object-${i.id}`,
            transition: {
              layout: { duration: 0.46, ease: [0.22, 0.61, 0.36, 1] },
            },
            children: [
              S.jsxs("div", {
                className: "focus-layer__header tech micro",
                children: [
                  S.jsxs("span", {
                    children: ["FOCUS / ", i.type.toUpperCase()],
                  }),
                  S.jsx("button", {
                    type: "button",
                    onClick: a,
                    children: "RETURN / ESC",
                  }),
                ],
              }),
              S.jsx(qA, { object: i }),
            ],
          }),
        })
      : null,
  });
}
function kA({
  listening: i,
  amplitude: a = 4,
  idleCycleSeconds: r = 6.8,
  activeCycleSeconds: l = 2.2,
}) {
  const c = By(0),
    d = By(0),
    f = U.useRef(0),
    m = U.useRef((Math.PI * 2) / r),
    y = js();
  return (
    xA((p, g) => {
      if (y) {
        c.set(0), d.set(0);
        return;
      }
      const x = (Math.PI * 2) / (i ? l : r),
        b = 1 - Math.exp(-g / 340);
      (m.current += (x - m.current) * b), (f.current += m.current * (g / 1e3));
      const j = i ? a * 1.55 : a;
      c.set(Math.sin(f.current) * j), d.set(Math.sin(f.current) * 0.11);
    }),
    { y: c, rotate: d }
  );
}
function ZA({ className: i, glint: a = !1, title: r }) {
  const l = js();
  return S.jsxs("svg", {
    className: i,
    viewBox: "0 0 944 1133",
    role: r ? "img" : "presentation",
    "aria-label": r,
    shapeRendering: "geometricPrecision",
    children: [
      S.jsxs("defs", {
        children: [
          S.jsxs("clipPath", {
            id: "damocles-blade-clip",
            children: [
              S.jsx("polygon", { points: "393,465 440,512 440,976 393,929" }),
              S.jsx("polygon", { points: "461,533 479,551 479,1015 461,997" }),
            ],
          }),
          S.jsxs("linearGradient", {
            id: "damocles-glint",
            x1: "0",
            y1: "0",
            x2: "1",
            y2: "0",
            children: [
              S.jsx("stop", {
                offset: "0",
                stopColor: "white",
                stopOpacity: "0",
              }),
              S.jsx("stop", {
                offset: "0.45",
                stopColor: "white",
                stopOpacity: "0.1",
              }),
              S.jsx("stop", {
                offset: "0.52",
                stopColor: "white",
                stopOpacity: "0.95",
              }),
              S.jsx("stop", {
                offset: "0.59",
                stopColor: "white",
                stopOpacity: "0.1",
              }),
              S.jsx("stop", {
                offset: "1",
                stopColor: "white",
                stopOpacity: "0",
              }),
            ],
          }),
        ],
      }),
      S.jsxs("g", {
        fill: "currentColor",
        children: [
          S.jsx("polygon", { points: "393,465 440,512 440,976 393,929" }),
          S.jsx("polygon", { points: "461,533 479,551 479,1015 461,997" }),
          S.jsx("polygon", { points: "442,176 460,176 460,441 442,423" }),
          S.jsx("polygon", {
            points:
              "451,75 435,106 405,135 428,155 442,181 460,181 474,155 497,135 467,106",
          }),
          S.jsx("polygon", {
            points: "235,327 335,327 707,699 641,699 335,393 301,393",
          }),
        ],
      }),
      S.jsx("polygon", {
        points: "451,115 467,135 451,154 435,135",
        fill: "#000000",
      }),
      a && !l
        ? S.jsx("g", {
            clipPath: "url(#damocles-blade-clip)",
            children: S.jsx(St.rect, {
              x: "340",
              y: "380",
              width: "190",
              height: "92",
              fill: "url(#damocles-glint)",
              initial: { y: 0, opacity: 0 },
              animate: { y: [0, 610], opacity: [0, 0.9, 0] },
              transition: {
                duration: 1.05,
                times: [0, 0.48, 1],
                ease: "easeInOut",
                repeat: 1 / 0,
                repeatDelay: 13.5,
              },
            }),
          })
        : null,
    ],
  });
}
const KA = [5, 10, 16, 8, 19, 12, 7, 17, 11, 6, 15, 9, 18, 7, 12, 5];
function PA({ compact: i = !1 }) {
  return S.jsxs(St.div, {
    className: `voice-indicator${i ? " voice-indicator--compact" : ""}`,
    initial: { opacity: 0, clipPath: "inset(0 44% 0 44%)", scaleX: 0.65 },
    animate: { opacity: 1, clipPath: "inset(0 0% 0 0%)", scaleX: 1 },
    exit: { opacity: 0, clipPath: "inset(0 48% 0 48%)", scaleX: 0.55 },
    transition: { duration: 0.26, ease: [0.22, 0.61, 0.36, 1] },
    "aria-label": "Voice stream active",
    children: [
      S.jsx("div", {
        className: "voice-indicator__bars",
        "aria-hidden": "true",
        children: KA.map((a, r) =>
          S.jsx(
            St.i,
            {
              style: { height: a },
              animate: {
                scaleY: [0.3, 1, 0.48, 0.78, 0.3],
                opacity: [0.35, 0.95, 0.58, 0.78, 0.35],
              },
              transition: {
                duration: 1.05,
                ease: "easeInOut",
                repeat: 1 / 0,
                delay: -((r * 0.13) % 0.9),
              },
            },
            r,
          ),
        ),
      }),
      S.jsx("div", {
        className: "voice-indicator__label tech micro",
        children: "VOICE STREAM / ACTIVE",
      }),
    ],
  });
}
function da({
  listening: i,
  onToggleListening: a,
  context: r = "GENERAL",
  size: l = "rail",
  showCaption: c = !0,
  interactive: d = !0,
  layoutId: f = "damocles-presence",
}) {
  const { y: m, rotate: y } = kA({
      listening: i,
      amplitude: l === "idle" ? 8.5 : l === "conversation" ? 5.5 : 4,
    }),
    p = S.jsxs(S.Fragment, {
      children: [
        S.jsx(St.div, {
          className: "damocles-presence__float",
          style: { y: m, rotate: y },
          children: S.jsx(ZA, { glint: i, title: "Damocles" }),
        }),
        S.jsx("div", {
          className: "damocles-presence__signal",
          children: S.jsx(fa, {
            mode: "wait",
            initial: !1,
            children: i
              ? S.jsx(PA, { compact: l === "compact" || l === "rail" }, "voice")
              : c
                ? S.jsxs(
                    St.div,
                    {
                      className: "damocles-presence__caption tech micro",
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                      transition: { duration: 0.16 },
                      children: [
                        "VOICE / ACTIVE",
                        S.jsx("br", {}),
                        S.jsxs("span", {
                          className: "muted",
                          children: ["CONTEXT / ", r],
                        }),
                      ],
                    },
                    "caption",
                  )
                : null,
          }),
        }),
      ],
    });
  return S.jsx(St.div, {
    className: `damocles-presence damocles-presence--${l}`,
    layoutId: f,
    layout: "position",
    transition: { layout: { duration: 0.42, ease: [0.22, 0.61, 0.36, 1] } },
    "data-testid": "damocles-presence",
    children: d
      ? S.jsx("button", {
          className: "damocles-presence__button",
          type: "button",
          onClick: a,
          "aria-pressed": i,
          "aria-label": i ? "Stop listening" : "Start listening",
          children: p,
        })
      : S.jsx("div", {
          className:
            "damocles-presence__button damocles-presence__button--static",
          children: p,
        }),
  });
}
function yn({ objectId: i, children: a, className: r, ...l }) {
  return S.jsx(St.div, {
    className: r,
    layout: !0,
    layoutId: `switchboard-object-${i}`,
    initial: {
      opacity: 0,
      filter: "blur(8px)",
      clipPath: "inset(48% 0 48% 0)",
    },
    animate: { opacity: 1, filter: "blur(0px)", clipPath: "inset(0% 0 0% 0)" },
    exit: { opacity: 0, filter: "blur(7px)", clipPath: "inset(48% 0 48% 0)" },
    transition: {
      opacity: { duration: 0.22 },
      filter: { duration: 0.28 },
      clipPath: { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] },
      layout: { duration: 0.42, ease: [0.22, 0.61, 0.36, 1] },
    },
    ...l,
    children: a,
  });
}
function wr({ left: i, right: a }) {
  return S.jsxs("div", {
    className: "scene-footer tech micro",
    "aria-hidden": "true",
    children: [S.jsx("span", { children: i }), S.jsx("span", { children: a })],
  });
}
function As({ children: i, onActivate: a, ariaLabel: r, className: l }) {
  const c = (d) => {
    (d.key !== "Enter" && d.key !== " ") || (d.preventDefault(), a());
  };
  return S.jsx("div", {
    className: `focusable-content${l ? ` ${l}` : ""}`,
    role: "button",
    tabIndex: 0,
    "aria-label": r,
    onClick: a,
    onKeyDown: c,
    children: i,
  });
}
function Ls() {
  return S.jsxs(S.Fragment, {
    children: [
      S.jsx("svg", {
        className: "corner-mark corner-mark--top",
        viewBox: "0 0 420 120",
        preserveAspectRatio: "none",
        "aria-hidden": "true",
        children: S.jsx("path", { d: "M 0 118 V 18 H 248 L 286 0 H 420" }),
      }),
      S.jsx("svg", {
        className: "corner-mark corner-mark--bottom",
        viewBox: "0 0 360 100",
        preserveAspectRatio: "none",
        "aria-hidden": "true",
        children: S.jsx("path", { d: "M 360 0 V 78 H 118 L 82 100 H 0" }),
      }),
    ],
  });
}
function Vr(i, a) {
  return i.speech
    ? { tag: "DAMOCLES / EXPLANATION", segments: [{ text: i.speech.text }] }
    : (a?.data ?? null);
}
function ha({ state: i, onToggleListening: a }) {
  return S.jsx(St.section, {
    className: "scene scene--idle",
    "data-scene": "idle",
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    children: S.jsx(da, {
      listening: i.listening,
      onToggleListening: a,
      size: "idle",
      showCaption: !1,
    }),
  });
}
function QA({
  state: i,
  onToggleListening: a,
  transcriptOpen: r,
  setTranscriptOpen: l,
}) {
  const c = Ns(i);
  if (!c) return S.jsx(ha, { state: i, onToggleListening: a });
  const d = Nr.message(c).data,
    f = i.speech ? [{ text: i.speech.text }] : d.segments;
  return S.jsxs(St.section, {
    className: "scene scene--conversation",
    "data-scene": "conversation",
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    children: [
      S.jsx(Ls, {}),
      S.jsx("div", {
        className: "conversation-presence-band",
        children: S.jsx(da, {
          listening: i.listening,
          onToggleListening: a,
          context: d.context ?? "CONVERSATION",
          size: "conversation",
          showCaption: !1,
        }),
      }),
      S.jsxs(yn, {
        objectId: c.id,
        className: "conversation-answer",
        children: [
          S.jsx(_s, { variant: "panel" }),
          S.jsx("div", {
            className: "conversation-answer__tag tech micro",
            children: d.tag ?? "CURRENT RESPONSE / 01",
          }),
          S.jsx("div", {
            className: "conversation-answer__text",
            children: S.jsx(V0, { segments: f }),
          }),
          S.jsx("div", {
            className: "conversation-answer__index tech micro",
            children: "VOICE / 01",
          }),
        ],
      }),
      S.jsxs("div", {
        className: "conversation-channel tech micro",
        children: [
          "CHANNEL / ",
          d.channel?.name ?? "VOICE",
          S.jsx("br", {}),
          "MODE / ",
          d.channel?.mode ?? "HANDS-FREE",
        ],
      }),
      S.jsx("button", {
        className: "transcript-toggle tech micro",
        type: "button",
        onClick: () => l(!0),
        children: "TRANSCRIPT HIDDEN",
      }),
      S.jsx(fa, {
        children: r
          ? S.jsxs(St.div, {
              className: "transcript",
              initial: { opacity: 0 },
              animate: { opacity: 1 },
              exit: { opacity: 0 },
              transition: { duration: 0.24 },
              children: [
                S.jsxs("div", {
                  className: "transcript__header tech micro",
                  children: [
                    S.jsx("span", { children: "CONVERSATION / HISTORY" }),
                    S.jsx("button", {
                      type: "button",
                      onClick: () => l(!1),
                      children: "RETURN / ESC",
                    }),
                  ],
                }),
                S.jsx("div", {
                  className: "transcript__body",
                  children: (d.transcript ?? []).map((m, y) =>
                    S.jsxs(
                      "div",
                      {
                        className: `transcript-line${m.speaker === "DAMOCLES" ? " transcript-line--ai" : ""}`,
                        children: [
                          S.jsx("span", {
                            className: "transcript-line__speaker tech micro",
                            children: m.speaker,
                          }),
                          S.jsx("span", { children: m.text }),
                        ],
                      },
                      `${y}-${m.speaker}`,
                    ),
                  ),
                }),
                S.jsx("input", {
                  className: "transcript__input",
                  placeholder: "TYPE OR SPEAK",
                  "aria-label": "Conversation input",
                }),
              ],
            })
          : null,
      }),
    ],
  });
}
function JA({ state: i, onToggleListening: a, onFocus: r }) {
  const l = mi(i, "chart"),
    c = mi(i, "metric"),
    d = mi(i, "progress")[0],
    f = mi(i, "note")[0],
    m = Vr(i, f),
    y = l.find((p) => p.role === "primary") ?? l[0];
  return y
    ? S.jsxs(St.section, {
        className: "scene scene--content scene--training",
        "data-scene": "training",
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        children: [
          S.jsx(Ls, {}),
          S.jsxs("div", {
            className: "scene-heading",
            children: [
              S.jsx("div", {
                className: "scene-heading__title tech",
                children: y.data.title ?? "TRAINING / RUN",
              }),
              S.jsx("div", {
                className: "scene-heading__sub tech micro",
                children: y.data.subtitle ?? "LOSS TRACE / LIVE",
              }),
            ],
          }),
          S.jsxs("div", {
            className: "content-grid",
            children: [
              S.jsxs(St.div, {
                className: "content-main training-main",
                layout: !0,
                children: [
                  S.jsx("div", {
                    className: `training-charts${l.length > 1 ? " training-charts--compare" : ""}`,
                    children: S.jsx(fa, {
                      mode: "popLayout",
                      initial: !1,
                      children: l.map((p) =>
                        S.jsxs(
                          yn,
                          {
                            objectId: p.id,
                            className: "chart-object",
                            children: [
                              S.jsx(_s, { variant: "panel" }),
                              S.jsx(As, {
                                onActivate: () => r(p.id),
                                ariaLabel: `Expand ${p.data.title ?? "chart"}`,
                                children: S.jsx(_0, { data: p.data }),
                              }),
                              p.role === "compare"
                                ? S.jsxs("div", {
                                    className: "compare-label tech micro",
                                    children: [
                                      "COMPARE / ",
                                      p.data.compareLabel ?? "RUN",
                                    ],
                                  })
                                : null,
                            ],
                          },
                          p.id,
                        ),
                      ),
                    }),
                  }),
                  m
                    ? S.jsx(St.div, {
                        className: "training-note",
                        layout: !0,
                        initial: { opacity: 0 },
                        animate: { opacity: 1 },
                        children: S.jsx(Vs, {
                          data: m,
                          onFocus: f ? () => r(f.id) : void 0,
                        }),
                      })
                    : null,
                  d
                    ? S.jsx(yn, {
                        objectId: d.id,
                        className: "training-progress",
                        children: S.jsx(As, {
                          onActivate: () => r(d.id),
                          ariaLabel: "Expand progress",
                          children: S.jsx(H0, { data: d.data }),
                        }),
                      })
                    : null,
                ],
              }),
              S.jsxs(St.aside, {
                className: "content-rail",
                layout: !0,
                children: [
                  S.jsx(da, {
                    listening: i.listening,
                    onToggleListening: a,
                    context: y.data.context ?? "TRAINING RUN",
                    size: "rail",
                  }),
                  S.jsx(B0, { metrics: c }),
                ],
              }),
            ],
          }),
          S.jsx(wr, {
            left: "DISPLAY / COMPOSED",
            right: "PRIMARY / LOSS TRACE",
          }),
        ],
      })
    : S.jsx(ha, { state: i, onToggleListening: a });
}
function FA({ state: i, onToggleListening: a, onFocus: r }) {
  const l = Ns(i);
  if (!l) return S.jsx(ha, { state: i, onToggleListening: a });
  const c = Nr.diagram(l),
    d = mi(i, "note")[0],
    f = Vr(i, d);
  return S.jsxs(St.section, {
    className: "scene scene--content scene--architecture",
    "data-scene": "architecture",
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    children: [
      S.jsx(Ls, {}),
      S.jsxs("div", {
        className: "scene-heading",
        children: [
          S.jsx("div", {
            className: "scene-heading__title tech",
            children: c.data.title ?? "SYSTEM / DIAGRAM",
          }),
          S.jsx("div", {
            className: "scene-heading__sub tech micro",
            children: c.data.subtitle ?? "GRAPH / COMPOSED",
          }),
        ],
      }),
      S.jsxs("div", {
        className: "content-grid",
        children: [
          S.jsxs(yn, {
            objectId: c.id,
            className: "content-main diagram-object",
            children: [
              S.jsx(_s, { variant: "open" }),
              S.jsx(As, {
                onActivate: () => r(c.id),
                ariaLabel: "Expand diagram",
                children: S.jsx(z0, { data: c.data }),
              }),
            ],
          }),
          S.jsxs(St.aside, {
            className: "content-rail",
            layout: !0,
            children: [
              S.jsx(da, {
                listening: i.listening,
                onToggleListening: a,
                context: c.data.context ?? "SYSTEM MAP",
                size: "rail",
              }),
              f
                ? S.jsx(yn, {
                    objectId: d?.id ?? "speech-note",
                    className: "rail-note",
                    children: S.jsx(Vs, {
                      data: f,
                      onFocus: d ? () => r(d.id) : void 0,
                    }),
                  })
                : null,
            ],
          }),
        ],
      }),
      S.jsx(wr, {
        left: "DISPLAY / SYSTEM MAP",
        right: "TRACE / ACTIVE ROUTE",
      }),
    ],
  });
}
function $A({ state: i, onToggleListening: a, onFocus: r }) {
  const l = Ns(i);
  if (!l) return S.jsx(ha, { state: i, onToggleListening: a });
  const c = Nr.document(l),
    d = mi(i, "note")[0],
    f = Vr(i, d);
  return S.jsxs(St.section, {
    className: "scene scene--content scene--document",
    "data-scene": "document",
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    children: [
      S.jsx(Ls, {}),
      S.jsxs("div", {
        className: "scene-heading",
        children: [
          S.jsxs("div", {
            className: "scene-heading__title tech",
            children: ["DOCUMENT / ", c.data.kind?.toUpperCase() ?? "CONTENT"],
          }),
          S.jsx("div", {
            className: "scene-heading__sub tech micro",
            children: "CONTENT / ORIGINAL",
          }),
        ],
      }),
      S.jsxs("div", {
        className: "content-grid",
        children: [
          S.jsx(yn, {
            objectId: c.id,
            className: "content-main document-object",
            children: S.jsx(As, {
              onActivate: () => r(c.id),
              ariaLabel: "Expand document",
              children: S.jsx(U0, { data: c.data }),
            }),
          }),
          S.jsxs(St.aside, {
            className: "content-rail",
            layout: !0,
            children: [
              S.jsx(da, {
                listening: i.listening,
                onToggleListening: a,
                context: c.data.context ?? "DOCUMENT",
                size: "rail",
              }),
              f
                ? S.jsx(yn, {
                    objectId: d?.id ?? "speech-note",
                    className: "rail-note",
                    children: S.jsx(Vs, {
                      data: f,
                      onFocus: d ? () => r(d.id) : void 0,
                    }),
                  })
                : null,
            ],
          }),
        ],
      }),
      S.jsx(wr, {
        left: "CONTENT / ORIGINAL EMAIL",
        right: "CHROME / SWITCHBOARD",
      }),
    ],
  });
}
function WA({ state: i, onToggleListening: a, onFocus: r }) {
  const l = Ns(i);
  if (!l) return S.jsx(ha, { state: i, onToggleListening: a });
  const c = Nr.code(l),
    d = mi(i, "note")[0],
    f = Vr(i, d);
  return S.jsxs(St.section, {
    className: "scene scene--content scene--code",
    "data-scene": "code",
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    children: [
      S.jsx(Ls, {}),
      S.jsxs("div", {
        className: "scene-heading",
        children: [
          S.jsx("div", {
            className: "scene-heading__title tech",
            children: c.data.title ?? "SOURCE / LIVE",
          }),
          S.jsx("div", {
            className: "scene-heading__sub tech micro",
            children: c.data.file ?? "SOURCE",
          }),
        ],
      }),
      S.jsxs("div", {
        className: "content-grid",
        children: [
          S.jsx(yn, {
            objectId: c.id,
            className: "content-main code-object",
            children: S.jsx(As, {
              onActivate: () => r(c.id),
              ariaLabel: "Expand code",
              children: S.jsx(L0, { data: c.data }),
            }),
          }),
          S.jsxs(St.aside, {
            className: "content-rail",
            layout: !0,
            children: [
              S.jsx(da, {
                listening: i.listening,
                onToggleListening: a,
                context: c.data.context ?? "SOURCE",
                size: "rail",
              }),
              f
                ? S.jsx(yn, {
                    objectId: d?.id ?? "speech-note",
                    className: "rail-note",
                    children: S.jsx(Vs, {
                      data: f,
                      onFocus: d ? () => r(d.id) : void 0,
                    }),
                  })
                : null,
            ],
          }),
        ],
      }),
      S.jsx(wr, {
        left: "FRAME / INTERRUPTED RAILS",
        right: "DISPLAY / SOURCE",
      }),
    ],
  });
}
function IA() {
  const {
      state: i,
      dispatch: a,
      transcriptOpen: r,
      setTranscriptOpen: l,
      voiceRuntime: c,
    } = ws(),
    d = bA(i),
    f = i.focusId ? (i.objects[i.focusId] ?? null) : null,
    m = {
      state: i,
      onToggleListening: () =>
        c ? c.toggleTurn() : a({ op: "listen", on: !i.listening }),
      onFocus: (y) => a({ op: "focus", id: y }),
      transcriptOpen: r,
      setTranscriptOpen: l,
    };
  return S.jsx(dE, {
    id: "switchboard-layout",
    children: S.jsxs("main", {
      className: "stage",
      "data-scene-kind": d,
      children: [
        S.jsxs(fa, {
          mode: "sync",
          initial: !1,
          children: [
            d === "idle"
              ? S.jsx(
                  ha,
                  { state: i, onToggleListening: m.onToggleListening },
                  "idle",
                )
              : null,
            d === "conversation" ? S.jsx(QA, { ...m }, "conversation") : null,
            d === "training" ? S.jsx(JA, { ...m }, "training") : null,
            d === "architecture" ? S.jsx(FA, { ...m }, "architecture") : null,
            d === "document" ? S.jsx($A, { ...m }, "document") : null,
            d === "code" ? S.jsx(WA, { ...m }, "code") : null,
          ],
        }),
        S.jsx(XA, { object: f, onClose: () => a({ op: "focus", id: null }) }),
      ],
    }),
  });
}
const t2 = new Set([
    "chart",
    "metric",
    "progress",
    "diagram",
    "document",
    "code",
    "message",
    "note",
  ]),
  e2 = new Set(["primary", "compare", "secondary", "ambient"]),
  n2 = new Set(["show", "hide", "say", "focus", "listen", "clear"]),
  i2 = 128,
  a2 = 5e4,
  s2 = 256e3;
function qc(i) {
  return typeof i == "object" && i !== null && !Array.isArray(i);
}
function Xc(i) {
  return typeof i == "string" && i.trim().length > 0 && i.length <= i2;
}
function ky(i) {
  return i == null || Xc(i);
}
function l2(i) {
  try {
    return new TextEncoder().encode(JSON.stringify(i)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function r2(i) {
  return i == null
    ? !0
    : !qc(i) ||
        (i.x !== void 0 && (typeof i.x != "number" || !Number.isFinite(i.x))) ||
        (i.series !== void 0 && typeof i.series != "string")
      ? !1
      : Object.keys(i).every((a) => a === "x" || a === "series");
}
function o2(i) {
  const r = [
    "layout",
    "style",
    "css",
    "className",
    "width",
    "height",
    "left",
    "right",
    "top",
    "bottom",
  ].find((l) => l in i);
  return r ? `model-controlled layout field is forbidden: ${r}` : null;
}
function u2(i) {
  if (!qc(i)) return { ok: !1, error: "action must be an object" };
  if (l2(i) > s2) return { ok: !1, error: "action exceeds size limit" };
  if (typeof i.op != "string" || !n2.has(i.op))
    return { ok: !1, error: "unknown operation" };
  const a = o2(i);
  if (a) return { ok: !1, error: a };
  switch (i.op) {
    case "show":
      return Xc(i.id)
        ? typeof i.type != "string" || !t2.has(i.type)
          ? { ok: !1, error: "show.type is unknown" }
          : i.role !== void 0 && (typeof i.role != "string" || !e2.has(i.role))
            ? { ok: !1, error: "show.role is unknown" }
            : qc(i.data)
              ? {
                  ok: !0,
                  action: {
                    op: "show",
                    id: i.id,
                    type: i.type,
                    role: i.role,
                    data: i.data,
                  },
                }
              : { ok: !1, error: "show.data must be an object" }
        : { ok: !1, error: "show.id must be a non-empty identifier" };
    case "hide":
      return Xc(i.id)
        ? { ok: !0, action: { op: "hide", id: i.id } }
        : { ok: !1, error: "hide.id must be a non-empty identifier" };
    case "say":
      return typeof i.text != "string" ||
        i.text.length === 0 ||
        i.text.length > a2
        ? {
            ok: !1,
            error: "say.text must be non-empty and within the text limit",
          }
        : ky(i.target)
          ? r2(i.at)
            ? {
                ok: !0,
                action: { op: "say", text: i.text, target: i.target, at: i.at },
              }
            : { ok: !1, error: "say.at is invalid" }
          : { ok: !1, error: "say.target is invalid" };
    case "focus":
      return ky(i.id)
        ? { ok: !0, action: { op: "focus", id: i.id } }
        : { ok: !1, error: "focus.id is invalid" };
    case "listen":
      return typeof i.on == "boolean"
        ? { ok: !0, action: { op: "listen", on: i.on } }
        : { ok: !1, error: "listen.on must be boolean" };
    case "clear":
      return { ok: !0, action: { op: "clear" } };
    default:
      return { ok: !1, error: "unknown operation" };
  }
}
function kc(i) {
  const a = u2(i);
  if (!a.ok) throw new TypeError(`Invalid Switchboard action: ${a.error}`);
  return a.action;
}
const nr = (i) => new Promise((a) => setTimeout(a, i));
function c2({ open: i, onClose: a }) {
  const { state: r, dispatch: l, loadFixture: c } = ws(),
    [d, f] = U.useState(
      '{"op":"show","id":"gpu","type":"metric","data":{"label":"GPU","value":"94%"}}',
    ),
    [m, y] = U.useState(null),
    p = U.useRef(0),
    g = () => {
      try {
        const b = kc(JSON.parse(d));
        l(b), y(null);
      } catch (b) {
        y(b instanceof Error ? b.message : "Invalid action");
      }
    },
    x = async () => {
      const b = ++p.current;
      c("training"),
        await nr(700),
        b === p.current &&
          (l({
            op: "show",
            id: "gpu",
            type: "metric",
            data: { label: "GPU", value: "94%" },
          }),
          await nr(700),
          b === p.current &&
            (l({
              op: "say",
              target: "loss",
              at: { x: 32, series: "VAL LOSS" },
              text: "Validation begins diverging here. The training curve is still descending normally.",
            }),
            await nr(800),
            b === p.current &&
              (l(Hy),
              await nr(900),
              b === p.current && l({ op: "hide", id: "gpu" }))));
    };
  return S.jsxs("aside", {
    className: `controller-panel${i ? " controller-panel--open" : ""}`,
    "aria-hidden": !i,
    children: [
      S.jsxs("div", {
        className: "controller-panel__head tech micro",
        children: [
          S.jsx("span", { children: "V17.2 / CONTROLLER" }),
          S.jsx("button", { type: "button", onClick: a, children: "CLOSE" }),
        ],
      }),
      S.jsxs("div", {
        className: "controller-panel__grid",
        children: [
          S.jsx("button", {
            type: "button",
            onClick: () => c("training"),
            children: "LOAD TRAINING",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () =>
              l({
                op: "show",
                id: "gpu",
                type: "metric",
                data: { label: "GPU", value: "94%" },
              }),
            children: "+ GPU",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () => l({ op: "focus", id: "loss" }),
            children: "FOCUS LOSS",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () =>
              l({
                op: "say",
                target: "loss",
                at: { x: 32, series: "VAL LOSS" },
                text: "Validation begins diverging here. The training curve is still descending normally.",
              }),
            children: "ANNOTATE",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () => l(Hy),
            children: "+ PREVIOUS RUN",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () => l({ op: "hide", id: "gpu" }),
            children: "- GPU",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () => l({ op: "listen", on: !r.listening }),
            children: "LISTEN",
          }),
          S.jsx("button", {
            type: "button",
            onClick: () => l({ op: "clear" }),
            children: "CLEAR",
          }),
        ],
      }),
      S.jsx("button", {
        className: "controller-panel__demo",
        type: "button",
        onClick: x,
        children: "RUN MOTION DEMO",
      }),
      S.jsx("label", {
        className: "controller-panel__label tech micro",
        htmlFor: "raw-action",
        children: "RAW ACTION / JSON",
      }),
      S.jsx("textarea", {
        id: "raw-action",
        value: d,
        onChange: (b) => f(b.target.value),
      }),
      S.jsx("button", {
        className: "controller-panel__send",
        type: "button",
        onClick: g,
        children: "DISPATCH",
      }),
      m
        ? S.jsxs("div", {
            className: "controller-panel__error tech micro",
            children: ["ERROR / ", m],
          })
        : null,
      S.jsx("pre", {
        className: "controller-panel__state",
        children: JSON.stringify(r, null, 2),
      }),
    ],
  });
}
function f2({ open: i, onClose: a }) {
  const { state: r } = ws();
  return S.jsxs("aside", {
    className: `ir-drawer${i ? " ir-drawer--open" : ""}`,
    "aria-hidden": !i,
    children: [
      S.jsxs("div", {
        className: "ir-drawer__head tech micro",
        children: [
          S.jsx("span", { children: "SCENE IR / LIVE" }),
          S.jsx("button", { type: "button", onClick: a, children: "CLOSE" }),
        ],
      }),
      S.jsx("pre", { children: JSON.stringify(r, null, 2) }),
    ],
  });
}
const fi = [
    "idle",
    "conversation",
    "training",
    "architecture",
    "email",
    "code",
  ],
  d2 = "switchboard-legacy-runtime",
  h2 = "switchboard-v17",
  m2 = {
    connected: !1,
    recording: !1,
    status: "Connecting…",
    handsFree: !1,
    handsFreeStatus: "Standby",
    handsFreeLease: "",
    route: "operator",
    routes: [{ value: "operator", label: "Operator" }],
    model: "",
    models: [],
    thinking: "",
    thinkingLevels: [],
    onProject: !1,
    modelDisabled: !0,
    thinkingDisabled: !0,
  };
function Nt(i) {
  return typeof i == "string" ? i : "";
}
function p2(i) {
  return i === "done"
    ? "green"
    : i === "active"
      ? "cyan"
      : i === "blocked"
        ? "amber"
        : "muted";
}
function y2(i) {
  return Array.isArray(i)
    ? i.flatMap((a) => {
        if (!a || typeof a != "object") return [];
        const r = a,
          l = Nt(r.text);
        return l
          ? [
              {
                speaker: r.role === "caller" ? "CALLER" : "DAMOCLES",
                text: l,
                id: Nt(r.id) || void 0,
              },
            ]
          : [];
      })
    : [];
}
function g2(i) {
  const r = (
    Array.isArray(i.items)
      ? i.items.filter((l) => !!(l && typeof l == "object"))
      : []
  ).map((l, c) => ({
    id: `step-${c + 1}`,
    label: Nt(l.label) || `STEP ${c + 1}`,
    sub: Nt(l.detail),
    detail: typeof l.ms == "number" ? `${l.ms}ms` : void 0,
    semantic: p2(l.state),
  }));
  return {
    title:
      Nt(i.title) ||
      (i.kind === "timeline" ? "CALL PATH / TIMELINE" : "PLAN / LIVE"),
    subtitle: i.kind === "timeline" ? "SEQUENCE / LIVE" : "EXECUTION / LIVE",
    context: Nt(i.notes) || "LIVE WORK",
    nodes: r,
    edges: r
      .slice(1)
      .map((l, c) => ({
        from: r[c].id,
        to: l.id,
        semantic: l.semantic,
        active: l.semantic === "cyan",
      })),
  };
}
function v2(i) {
  return !!(i && typeof i == "object");
}
function S2() {
  const { dispatch: i, registerVoiceRuntime: a } = ws(),
    r = U.useRef(null),
    l = U.useRef([]),
    c = U.useRef(""),
    d = U.useRef(null),
    f = U.useRef(!1),
    [m, y] = U.useState(m2),
    p = U.useCallback((x, b) => {
      r.current?.contentWindow?.postMessage(
        { source: h2, command: x, value: b },
        window.location.origin,
      );
    }, []),
    g = U.useCallback(
      (x) => {
        x !== void 0 && (c.current = x);
        const b = {
          context:
            m.route === "operator"
              ? "OPERATOR LINE"
              : `PROJECT / ${m.route.toUpperCase()}`,
          tag: "CURRENT RESPONSE / LIVE",
          segments: [{ text: c.current || "Line open. Speak when ready." }],
          channel: {
            name: "VOICE",
            mode: m.handsFree ? "HANDS-FREE" : "PUSH-TO-TALK",
          },
          transcript: l.current,
        };
        (f.current = !1),
          i({ op: "hide", id: "live-visual" }),
          i({ op: "hide", id: "live-progress" }),
          i({
            op: "show",
            id: "conversation",
            type: "message",
            role: "primary",
            data: b,
          });
      },
      [i, m.handsFree, m.route],
    );
  return (
    U.useEffect(() => {
      const x = (A) => {
          const R = A.id ? l.current.findIndex((V) => V.id === A.id) : -1;
          R >= 0
            ? (l.current = l.current.map((V, L) => (L === R ? A : V)))
            : (l.current = [...l.current, A].slice(-200));
        },
        b = (A) => {
          switch (A.type) {
            case "epoch":
              (l.current = []),
                (c.current = ""),
                (d.current = null),
                (f.current = !1),
                i({ op: "clear" });
              break;
            case "history": {
              l.current = y2(A.entries);
              const R = [...l.current]
                .reverse()
                .find((V) => V.speaker === "DAMOCLES");
              (c.current = R?.text ?? ""), l.current.length > 0 && g();
              break;
            }
            case "transcript": {
              const R = Nt(A.text);
              if (!R) break;
              x({ speaker: "CALLER", text: R, id: Nt(A.id) || void 0 }),
                f.current || g();
              break;
            }
            case "spoken": {
              const R = A.entry;
              if (!R || typeof R != "object") break;
              const V = R,
                L = Nt(V.text);
              if (!L) break;
              x({ speaker: "DAMOCLES", text: L, id: Nt(V.id) || void 0 }),
                (c.current = L),
                f.current
                  ? i({ op: "say", target: "live-visual", text: L })
                  : g(L);
              break;
            }
            case "reply": {
              const R = Nt(A.text) || "(No spoken response.)";
              x({ speaker: "DAMOCLES", text: R }),
                (c.current = R),
                f.current
                  ? i({ op: "say", target: "live-visual", text: R })
                  : g(R);
              break;
            }
            case "thinking":
              i({ op: "listen", on: !1 });
              break;
            case "activity": {
              const R = [Nt(A.label), Nt(A.detail)].filter(Boolean).join(" / ");
              R && i({ op: "say", text: R });
              break;
            }
            case "diagram": {
              const R = Nt(A.kind) || "mermaid";
              if (R === "diff") {
                const L = {
                  op: "show",
                  id: "live-visual",
                  type: "code",
                  role: "primary",
                  data: {
                    title: Nt(A.title) || "CHANGESET / LIVE",
                    file: "UNIFIED DIFF",
                    context: Nt(A.notes) || "LIVE WORK",
                    source: { language: "diff", text: Nt(A.source) },
                  },
                };
                (d.current = L),
                  (f.current = !0),
                  i({ op: "hide", id: "conversation" }),
                  i(L);
              } else {
                const L = {
                  op: "show",
                  id: "live-visual",
                  type: "diagram",
                  role: "primary",
                  data:
                    R === "plan" || R === "timeline"
                      ? g2(A)
                      : {
                          title: Nt(A.title) || "SYSTEM / DIAGRAM",
                          subtitle: "MERMAID / LIVE",
                          context: Nt(A.notes) || "LIVE WORK",
                          source: Nt(A.source),
                          nodes: [],
                          edges: [],
                        },
                };
                if (
                  ((d.current = L),
                  (f.current = !0),
                  i({ op: "hide", id: "conversation" }),
                  i(L),
                  (R === "plan" || R === "timeline") && Array.isArray(A.items))
                ) {
                  const _ = A.items.find(
                      (k) => k && typeof k == "object" && k.state === "active",
                    ),
                    H = _ ? A.items.indexOf(_) : A.items.length,
                    X = {
                      label: R === "timeline" ? "ACTIVE HOP" : "PLAN PROGRESS",
                      detail:
                        _ && typeof _ == "object" ? Nt(_.label) : "COMPLETE",
                      value: A.items.length
                        ? Math.min(1, Math.max(0, H / A.items.length))
                        : 0,
                      text: `${H}/${A.items.length}`,
                    };
                  i({
                    op: "show",
                    id: "live-progress",
                    type: "progress",
                    role: "secondary",
                    data: X,
                  });
                }
              }
              Nt(A.notes) &&
                i({ op: "say", target: "live-visual", text: Nt(A.notes) });
              break;
            }
            case "view": {
              const R = Nt(A.target);
              R === "comms"
                ? g()
                : (R === "visual" || R === "theater") && d.current
                  ? ((f.current = !0),
                    i({ op: "hide", id: "conversation" }),
                    i(d.current),
                    i({
                      op: "focus",
                      id: R === "theater" ? "live-visual" : null,
                    }))
                  : i({ op: "focus", id: null });
              break;
            }
            case "error": {
              const R = Nt(A.message) || "The line reported an error.";
              c.current ? i({ op: "say", text: R }) : g(R);
              break;
            }
          }
        },
        j = (A) => {
          if (A.origin !== window.location.origin) return;
          const R = A.data;
          if (R?.source === d2)
            if (R.kind === "state" && v2(R.payload)) {
              const V = R.payload;
              y((L) => ({ ...L, ...V })),
                i({ op: "listen", on: !!(V.recording || V.handsFree) });
            } else
              R.kind === "server" && R.payload && typeof R.payload == "object"
                ? b(R.payload)
                : R.kind === "ready" && p("state");
        };
      return (
        window.addEventListener("message", j),
        () => window.removeEventListener("message", j)
      );
    }, [p, i, g]),
    U.useEffect(
      () => (
        a({
          toggleTurn: () => {
            if (!m.connected) {
              p("retry");
              return;
            }
            p(m.recording ? "send" : "talk");
          },
        }),
        () => a(null)
      ),
      [p, a, m.connected, m.recording],
    ),
    S.jsx("iframe", {
      ref: r,
      className: "runtime-frame",
      src: "/legacy/index.html?runtime=1",
      title: "Switchboard voice runtime",
      allow: "microphone; autoplay",
      "aria-hidden": "true",
      tabIndex: -1,
    })
  );
}
const x2 = (i) => !!(i && fi.includes(i));
function b2() {
  const {
      state: i,
      dispatch: a,
      run: r,
      loadFixture: l,
      fixture: c,
      transcriptOpen: d,
      setTranscriptOpen: f,
    } = ws(),
    [m, y] = U.useState(!1),
    [p, g] = U.useState(!1),
    x = U.useRef(i);
  x.current = i;
  const b = U.useRef(null),
    j = U.useRef(!1),
    [A] = U.useState(() => {
      const R = new URLSearchParams(window.location.search);
      return R.has("scene") || R.get("demo") === "1";
    });
  return (
    U.useEffect(() => {
      if (j.current) return;
      j.current = !0;
      const R = new URLSearchParams(window.location.search),
        V = R.get("scene");
      A && l(x2(V) ? V : "idle"),
        R.get("chrome") === "0" &&
          document.body.classList.add("presentation-mode");
    }, [A, l]),
    U.useEffect(() => {
      window.SwitchboardController = {
        dispatch: (R) => a(kc(R)),
        run: (R) => r(R.map(kc)),
        load: l,
        state: () => x.current,
        protocol: TA,
      };
    }, [a, r, l]),
    U.useEffect(() => {
      const R = (V) => {
        if (V.target?.matches("input, textarea, select") && V.key !== "Escape")
          return;
        if (V.key === "Escape") {
          i.focusId
            ? a({ op: "focus", id: null })
            : d
              ? f(!1)
              : m
                ? y(!1)
                : p && g(!1);
          return;
        }
        if (!A) return;
        const _ = Number(V.key) - 1;
        if (_ >= 0 && _ < fi.length) {
          l(fi[_]);
          return;
        }
        const H = V.key.toLowerCase();
        H === "l" && a({ op: "listen", on: !i.listening }),
          H === "c" && y((X) => !X),
          H === "j" && g((X) => !X);
      };
      return (
        window.addEventListener("keydown", R),
        () => window.removeEventListener("keydown", R)
      );
    }, [m, A, a, p, l, f, i.focusId, i.listening, d]),
    U.useEffect(() => {
      const R = (L) => {
          !A ||
            L.touches.length !== 1 ||
            L.target?.closest(
              "button,input,textarea,.code-viewport__scroll,.document-viewport__body,.focus-layer,.controller-panel,.ir-drawer,.transcript",
            ) ||
            (b.current = {
              x: L.touches[0].clientX,
              y: L.touches[0].clientY,
              target: L.target,
            });
        },
        V = (L) => {
          const _ = b.current;
          if (((b.current = null), !_ || L.changedTouches.length !== 1)) return;
          const H = L.changedTouches[0].clientX - _.x,
            X = L.changedTouches[0].clientY - _.y;
          if (Math.abs(H) < 58 || Math.abs(H) < Math.abs(X)) return;
          const tt = (fi.indexOf(c) + (H < 0 ? 1 : -1) + fi.length) % fi.length;
          l(fi[tt]);
        };
      return (
        window.addEventListener("touchstart", R, { passive: !0 }),
        window.addEventListener("touchend", V, { passive: !0 }),
        () => {
          window.removeEventListener("touchstart", R),
            window.removeEventListener("touchend", V);
        }
      );
    }, [A, c, l]),
    S.jsxs("div", {
      className: "app-shell",
      children: [
        S.jsx(IA, {}),
        A
          ? S.jsxs(S.Fragment, {
              children: [
                S.jsx("button", {
                  className: "dev-toggle tech micro",
                  type: "button",
                  onClick: () => y(!0),
                  children: "CTRL",
                }),
                S.jsx(c2, { open: m, onClose: () => y(!1) }),
                S.jsx(f2, { open: p, onClose: () => g(!1) }),
              ],
            })
          : S.jsx(S2, {}),
      ],
    })
  );
}
gS.createRoot(document.getElementById("root")).render(
  S.jsx(U.StrictMode, { children: S.jsx(MA, { children: S.jsx(b2, {}) }) }),
);
export { LA as _ };
//# sourceMappingURL=index-ybtum36L.js.map
