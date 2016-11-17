"use strict";

let logger 			= require("./logger");
let config 			= require("../config");
let response		= require("./response");

let C 				= require("./constants");
let Sockets   		= require("./sockets");

let _ 				= require("lodash");


let Services; // circular reference

/**
 * Context class for requests
 * 
 * @param {any} called service
 */
class Context {
	/**
	 * Constructor of Context
	 * 
	 * @param {any} called service
	 */
	constructor(service) { 
		this.service = service; // service instance
		this.io = service.io; // namespace IO
		this.app = null; // ExpressJS app
		this.req = null; // req from ExpressJS router
		this.res = null; // res from ExpressJS router
		this.action = null; // action of service
		this.t = null; // i18n translate method
		this.user = null; // logged in user
		this.socket = null; // socket from socket.io session
		this.params = []; // params from ExpressJS REST or websocket or GraphQL args
		this.model = null; // model from `modelResolvers`
		this.provider = "internal"; // `internal`, `rest`, `socket` or `graphql`

		this.validationErrors = [];

		if (!Services) 
			Services = require("./services");
	}
/*
// Initialize Context from other context
Context.from = function(ctx, service) {
	let newCtx = _.defaults(new Context(service), ctx);
	newCtx.provider = "internal";
	return newCtx;
}
*/

	services(serviceName) {
		return Services.get(serviceName);
	}
	
	/**
	 * Create a new Context from a REST request
	 * 
	 * @param {any} service
	 * @param {any} action
	 * @param {any} app
	 * @param {any} req
	 * @param {any} res
	 * @returns
	 */
	static CreateFromREST(service, action, app, req, res) {
		let ctx = new Context(service);
		ctx.provider = "rest";
		ctx.app = app;
		ctx.req = req;
		ctx.res = res;
		ctx.t = req.t;
		ctx.user = req.user;
		ctx.params = _.defaults({}, req.query, req.params, req.body);
		ctx.action = action;

		return ctx;
	}

	/**
	 * Create a new Context from a websocket request
	 * 
	 * @param {any} service
	 * @param {any} action
	 * @param {any} app
	 * @param {any} socket
	 * @param {any} data
	 * @returns
	 */
	static CreateFromSocket(service, action, app, socket, data) {
		let ctx = new Context(service);
		ctx.provider = "socket";
		ctx.app = app;
		ctx.socket = socket;
		ctx.t = app.t;
		ctx.user = socket.request.user;
		ctx.params = data || {};
		ctx.action = action;

		return ctx;
	}

	/**
	 * Create a new Context from a GraphQL request
	 * 
	 * @param {any} service
	 * @param {any} action
	 * @param {any} root
	 * @param {any} args
	 * @param {any} context
	 * @returns
	 */
	static CreateFromGraphQL(service, action, root, args, context) {
		let ctx = new Context(service);
		ctx.provider = "graphql";
		ctx.t = context.t;
		ctx.params = args;
		ctx.user = context.user;
		ctx.action = action;

		return ctx;
	}

	/**
	 * Create a new Context for initialize services
	 * 
	 * @param {any} service
	 * @param {any} app
	 * @param {any} db
	 * @returns
	 */
	static CreateToServiceInit(service, app, db) {
		let ctx = new Context(service);
		ctx.provider = "";
		ctx.app = app;

		return ctx;
	}

	/**
	 * Resolve model from request by id/code
	 * 
	 * @returns
	 */
	resolveModel() {
		if (_.isFunction(this.service.modelResolver)) {
			let idParamName = this.service.idParamName || "id";

			let id = this.params[idParamName];

			if (id != null) {
				return this.service.modelResolver(this, id).then( (model) => {
					this.model = model;
					return model;
				});
			}
		}

		return Promise.resolve(null);
	}

	/**
	 * Check permission of request
	 * 
	 * @returns
	 */
	checkPermission() {
		let permission = this.action.permission || this.service.permission || C.PERM_LOGGEDIN;

		if (permission == C.PERM_PUBLIC)
			return Promise.resolve();


		return Promise.resolve()

		// check logged in
		.then(() => {
			if (!this.user)
				this.errorUnauthorized();
		})

		// check role
		.then(() => {
			if (permission == C.PERM_ADMIN && this.user.roles.indexOf(C.ROLE_ADMIN) == -1) {
				this.errorForbidden();
			}
			else if (permission == C.PERM_USER && this.user.roles.indexOf(C.ROLE_USER) == -1) {
				this.errorForbidden();
			}
		})

		// check owner
		.then(() => {
			if (permission == C.PERM_OWNER && _.isFunction(this.service.ownerChecker)) {
				return this.service.ownerChecker(this).catch((err) => {
					this.errorForbidden(C.ERR_ONLY_OWNER_CAN_EDIT_AND_DELETE, err ? err.message || err : this.t("YouAreNotTheOwner"));
				});
			}
		});
	}


	/**
	 * Broadcast a websocket message
	 * 
	 * @param {any} cmd		command of message
	 * @param {any} data	data of message
	 */
	broadcast(cmd, data) {
		if (this.io) {
			let path = "/" + this.service.namespace + "/" + cmd;
			logger.debug("Send WS broadcast message to '" + path + "':", data);
			this.io.emit(path, data);
		}
	}

	/**
	 * Send a message back to the requester
	 * 
	 * @param {any} cmd		command of message
	 * @param {any} data	data of message
	 */
	emitUser(cmd, data) {
		if (!this.socket && this.user) {
			// If not socket (come from REST), but has user, we try to find it
			this.socket = _.find(Sockets.userSockets, (socket) => { 
				return socket.request.user._id == this.user._id;
			});
		}
		if (this.socket) {
			let path = "/" + this.service.namespace + "/" + cmd;
			logger.debug("Send WS message to " + this.socket.request.user.username + " '" + path + "':", data);
			this.socket.emit(path, data);
		}
	}

	/**
	 * Broadcast a message to a role 
	 * 
	 * @param {any} cmd		command of message
	 * @param {any} data	data of message
	 * @param {any} role	If the `role` is not specified, we use the role of service
	 * @returns
	 */
	emit(cmd, data, role) {
		if (!role)
			role = this.service.role;
		
		// If not definied we will send a broadcast
		if (!role) {
			let path = "/" + this.service.namespace + "/" + cmd;
			logger.debug("Send WS broadcast message to '" + path + "':", data);

			if (this.socket)
				this.socket.broadcast.emit(path, data);
			else
				this.io.emit(path, data);

			return;
		}

		if (this.io) {
			let path = "/" + this.service.namespace + "/" + cmd;
			logger.debug("Send WS message to '" + role + "' role '" + path);

			_.each(Sockets.userSockets, (socket) => { 
				let user = socket.request.user;
				if (user && user.roles && user.roles.indexOf(role) !== -1) {
					// If requested via socket we omit the requester user
					if (this.provider == "socket" && user == this.user) return;

					logger.debug("Send WS message to " + user.username + " '" + path + "':", data);
					socket.emit(path, data);
				}
			});
		}

	}

	/**
	 * Check the context has the `name` parameter
	 * 
	 * @param {any} name
	 * @returns {boolean}
	 */
	hasParam(name, errorMessage) {
		return this.params[name] != null;
	}

	/**
	 * Validate the requested parameters
	 * 
	 * @param {any} name
	 * @param {any} errorMessage
	 * @returns
	 */
	validateParam(name, errorMessage) {
		let self = this;

		let validator = {
			name: name,
			value: null,
			errors: []
		};

		/**
		 * Check has no errors yet
		 * 
		 * @returns
		 */
		validator.noError = function() {
			return validator.errors.length == 0;
		};

		/**
		 * Add a new validation error
		 * 
		 * @param {any} message
		 */
		validator.addError = function(message) {
			validator.errors.push(message);
			self.validationErrors.push(message);
		};

		/**
		 * Close the validation. If no error set back the parameter value to this.params
		 * 
		 * @returns
		 */
		validator.end = function() {
			if (validator.noError())
				self.params[validator.name] = validator.value;

			return validator.value;
		};

		/**
		 * Throw exception if has validation error
		 * 
		 * @returns
		 */
		validator.throw = function() {
			if (!validator.noError())
				throw new Error(validator.errors.join(" "));
			
			return validator.value;
		};

		/**
		 * Assert the parameter is not empty
		 * 
		 * @param {any} errorMessage
		 * @returns
		 */
		validator.notEmpty = function(errorMessage) {
			if (validator.value == null || validator.value === "")
				validator.addError(errorMessage || `Parameter '${name}' is empty!`); // i18n

			if (_.isArray(validator.value) && validator.value.length == 0)
				validator.addError(errorMessage || `Parameter '${name}' is empty!`); // i18n

			return validator;
		};

		/**
		 * Assert the parameter is a Number
		 * 
		 * @param {any} errorMessage
		 * @returns
		 */
		validator.isNumber = function(errorMessage) {
			if (validator.value != null)
				return _.isNumber(validator.value);

			// We don't check if it is not null
			return true;
		};	

		/**
		 * Trim the content of parameter
		 * 
		 * @returns
		 */
		validator.trim = function() {
			if (validator.noError() && validator.value != null)
				validator.value = validator.value.trim();
			
			return validator;
		};

		let value = this.params[name];
		if (value != null) 
			validator.value = value;
		//else
		//	validator.addError(errorMessage || `Parameter '${name}' missing!`); // i18n

		return validator;
	}

	/**
	 * Check has validation errors
	 * 
	 * @returns
	 */
	hasValidationErrors() {
		return this.validationErrors.length > 0;
	}

	/**
	 * Generate and throw a new BAD_REQUEST response error
	 * 
	 * @param {any} type 	type of error
	 * @param {any} msg		message of error (localized)
	 */
	errorBadRequest(type, msg) {
		let err = new Error(msg);
		err = _.defaults(response.BAD_REQUEST);
		if (type)
			err.type = type;
		if (msg)
			err.message = msg;

		throw err;
	}

	/**
	 * Generate and throw a new FORBIDDEN response error
	 * 
	 * @param {any} type 	type of error
	 * @param {any} msg		message of error (localized)
	 */
	errorForbidden(type, msg) {
		let err = new Error(msg);
		err = _.defaults(response.FORBIDDEN);
		if (type)
			err.type = type;
		if (msg)
			err.message = msg;

		throw err;
	}

	/**
	 * Generate and throw a new UNAUTHORIZED response error
	 * 
	 * @param {any} type 	type of error
	 * @param {any} msg		message of error (localized)
	 */
	errorUnauthorized(type, msg) {
		let err = new Error(msg);
		err = _.defaults(response.UNAUTHORIZED);
		if (type)
			err.type = type;
		if (msg)
			err.message = msg;

		throw err;
	}

	/**
	 * Convert the `docs` MongoDB model to JSON object.
	 * With `skipFields` can be filter the properties
	 * 
	 * @param {any} 	docs		MongoDB document(s)
	 * @param {String} 	propFilter	Filter properties of model. It is a space-separated string 
	 * @returns						JSON object/array
	 */
	toJSON(docs, propFilter) {
		let func = function(doc) {
			let json = doc.toJSON();
			if (propFilter != null)
				return _.pick(json, propFilter);
			else
				return json;
		};

		if (docs == null) 
			docs = this.model;

		if (propFilter == null) {
			propFilter = this.service.modelPropFilter;
		}

		if (_.isString(propFilter)) 
			propFilter = propFilter.split(" ");

		if (_.isArray(docs)) {
			return _.map(docs, (doc) => func(doc, propFilter));
		} else if (_.isObject(docs)) {
			return func(docs);
		}
	}

	notifyChanges(type, json, role) {
		let response = {
			status: 200,
			event: type,
			data: json
		};

		if (this.user) {
			let userService = this.services("users");
			response.user = this.toJSON(this.user, "code username fullName gravatar lastLogin roles");
		}
		this.emit(type, response, role);	
	}

	/**
	 * Process limit, offset and sort params from request
	 * and use them in the query
	 *
	 * Example:
	 * 	GET /posts?offset=20&limit=10&sort=-votes,createdAtR
	 * 
	 * @param  {query} query Mongo query object
	 * @return {query}
	 */
	queryPageSort(query) {
		if (this.params) {
			if (this.params.limit)
				query.limit(this.params.limit);

			if (this.params.offset)
				query.skip(this.params.offset);

			if (this.params.sort)
				query.sort(this.params.sort.replace(/,/, " "));
		}
		return query;
	}

	/**
	 * Check the request is authenticated.
	 * 
	 * @param {any} role
	 * @returns
	 */
	isAuthenticated(role) {
		return this.user != null;
	}

	/**
	 * Check the request come from a user who has the required role
	 * 
	 * @param {any} role		required role
	 * @returns
	 */
	hasRole(role) {
		return this.user && this.user.roles.indexOf(role) != -1;
	}

}

module.exports = Context;