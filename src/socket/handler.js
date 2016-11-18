import Debug from 'debug';
import errors from 'feathers-errors';
import omit from 'lodash.omit';
import ms from 'ms';
import { normalizeError } from 'feathers-socket-commons/lib/utils';

const debug = Debug('feathers-authentication:sockets:handler');

function handleSocketCallback(promise, callback) {
  if (typeof callback === 'function') {
    promise.then(data => callback(null, data))
      .catch(error => {
        debug(`Socket authentication error`, error);
        callback(normalizeError(error));
      });
  }

  return promise;
}

export default function setupSocketHandler(app, options, { feathersParams, provider, emit, disconnect }) {
  const authSettings = app.get('auth');
  const service = app.service(authSettings.path);

  return function(socket) {
    let logoutTimer;

    const logout = function (callback = () => {}) {
      const connection = feathersParams(socket);
      const { accessToken } = connection;

      if (accessToken) {
        debug('Logging out socket with accessToken', accessToken);

        delete connection.accessToken;
        delete connection.authenticated;
        connection.headers = {};
        socket._feathers.body = {};

        const promise = service.remove(accessToken, { authenticated: true }).then(tokens => {
          debug(`Successfully logged out socket with accessToken`, accessToken);

          app.emit('logout', tokens, {
            provider,
            socket,
            connection
          });

          return tokens;
        });

        handleSocketCallback(promise, callback);
      }
    };

    const authenticate = function (data, callback = () => {}) {
      const { strategy } = data;
      const body = omit(data, 'strategy');

      socket._feathers = {
        query: {},
        params: {},
        body,
        headers: {},
        session: {},
        cookies: {}
      };

      if (!strategy) {
        const error = new errors.BadRequest(`An authentication 'strategy' must be provided.`);
        return callback(normalizeError(error));
      }

      if (!app.passport._strategy(strategy)) {
        const error = new Error(`Your '${strategy}' authentication strategy is not registered with passport.`);
        return callback(normalizeError(error));
      }

      const promise = app.authenticate(strategy, options[strategy])(socket._feathers)
        .then(result => {
          if (result.success) {
            // NOTE (EK): I don't think we need to support
            // custom redirects. We can emit this to the client
            // and let the client redirect.
            // if (options.successRedirect) {
            //   return {
            //     redirect: true,
            //     status: 302,
            //     url: options.successRedirect
            //   };
            // }
            return Promise.resolve(result.data);
          }

          if (result.fail) {
            // NOTE (EK): I don't think we need to support
            // custom redirects. We can emit this to the client
            // and let the client redirect.
            // if (options.failureRedirect) {
            //   return {
            //     redirect: true,
            //     status: 302,
            //     url: options.failureRedirect
            //   };
            // }

            const { challenge } = result;
            const message = options.failureMessage || (challenge && challenge.message);
            
            return Promise.reject(new errors[401](message, challenge));
          }

          // NOTE (EK): I don't think we need to support
          // redirects or even can. These are in place for
          // OAuth and you can't do typical OAuth over sockets.
          // if (result.redirect) {
          //   return { result };
          // }
          
          // NOTE (EK): This handles redirects and .pass()
          return Promise.reject(new errors.NotAuthenticated('Authentication could not complete. You might be using an unsupported socket authentication strategy. Refer to docs.feathersjs.com for more details.'));
        })
        .then(result => {
          // Now that we are authenticated create our JWT access token
          const params = Object.assign({ authenticated: true }, result);
          return service.create(result, params).then(tokens => {
            // Add the auth strategy response data and tokens to the socket connection
            // so that they can be referenced in the future. (ie. attach the user)
            let connection = feathersParams(socket);
            const headers = {
              [authSettings.header]: tokens.accessToken
            };

            connection = Object.assign(connection, result, tokens, { headers, authenticated: true });
            
            // Clear any previous timeout if we have logged in again.
            if (logoutTimer) {
              debug(`Clearing old timeout.`);
              logoutTimer.clearTimeout();
            }

            logoutTimer = setTimeout(() => {
              debug(`Token expired. Logging out.`);
              logout();
            }, ms(authSettings.jwt.expiresIn));

            // TODO (EK): Setup and tear down socket listeners to keep the entity
            // up to date that should be attached to the socket. Need to get the
            // entity or assignProperty
            // 
            
            // app.passport._registeredStrategies = {
            //   local: {
            //     entity,
            //     service
            //   }
            // };

            const stategyOptions = app.passport._registeredStrategies[strategy];
            const servicePath = strategyOptions.service;
            const service = typeof servicePath === 'string' ? app.service(servicePath) : servicePath;

            const updateEntity = function(data) {
              if (data[service.id] === connection[strategyOptions.entity][service.id]) {
                // Update the user
              }
            };

            // Remove old listeners to prevent leaks
            service.removeListener('updated', updateEntity);
            service.removeListener('patched', updateEntity);
            service.removeListener('removed', updateEntity);

            // Register new event listeners
            service.on('updated', updateEntity);
            service.on('patched', updateEntity);
            service.on('removed', updateEntity);

            app.emit('login', tokens, {
              provider,
              socket,
              connection
            });

            return Promise.resolve(tokens);
          });
        });

      handleSocketCallback(promise, callback);
    };

    socket.on('authenticate', authenticate);
    socket.on(disconnect, logout);
    socket.on('logout', logout);
  };
}