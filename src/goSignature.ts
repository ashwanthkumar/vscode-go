/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { SignatureHelpProvider, SignatureHelp, SignatureInformation, ParameterInformation, TextDocument, Position, CancellationToken, WorkspaceConfiguration } from 'vscode';
import { definitionLocation, GoDefinitionInformation } from './goDeclaration';
import { getParametersAndReturnType } from './util';
import rp = require("request-promise");
import { cpus } from 'os';

export class GoSignatureHelpProvider implements SignatureHelpProvider {
	private goConfig = null;

	constructor(goConfig?: WorkspaceConfiguration) {
		this.goConfig = goConfig;
	}

	private getPopularPatterns(callerPos: vscode.Position, res: GoDefinitionInformation, nrOfCommas: number): Promise<SignatureHelp> {
		if (!res) {
			// The definition was not found
			return null;
		}
		if (res.line === callerPos.line) {
			// This must be a function definition
			return null;
		}
		let declarationText: string = (res.declarationlines || []).join(' ').trim();
		if (!declarationText) {
			return null;
		}

		let url = "http://localhost:8080/popularForVSCode?file=" + res.file + "&func=" + declarationText;
		console.log("Querying " + url);
		let responses: any = rp.get(url).then(data => {
			console.log("Got Popular Patterns data from Sever")
			let popularPatternsResult: Array<any> = JSON.parse(data).result;
			console.log(popularPatternsResult);

			let result = new SignatureHelp();
			let sig: string;
			let si: SignatureInformation;
			// console.log(res);
			if (res.toolUsed === 'godef') {
				// declaration is of the form "Add func(a int, b int) int"
				let nameEnd = declarationText.indexOf(' ');
				let sigStart = nameEnd + 5; // ' func'
				let funcName = declarationText.substring(0, nameEnd);
				sig = declarationText.substring(sigStart);
				let popularPatterns = new vscode.MarkdownString("")
				if(popularPatternsResult.length > 0) {
					popularPatterns = popularPatterns.appendMarkdown("#### Popular Patterns");
				}

				for(let ptrn of popularPatternsResult.slice(0, 4)) {
					console.log(ptrn)
					ptrn.Code.repl
					popularPatterns = popularPatterns.appendCodeblock(ptrn.Code, "go")
				}
					
					// .appendCodeblock("fmt.Println(\"some string\")", "go")
					// .appendCodeblock("fmt.Println(\"some more string\")", "go")
					// .appendCodeblock("fmt.Println(\"some more string\")", "go")
					// .appendCodeblock("fmt.Println(\"some more string\")", "go")
					// .appendCodeblock("fmt.Println(\"some more string\")", "go")
					// .appendMarkdown("[View Examples](http://ashwanthkumar.in/)")
					// .value
				let documentAsMarkdown: vscode.MarkdownString = new vscode.MarkdownString(res.doc + popularPatterns.value);
				si = new SignatureInformation(funcName + sig, documentAsMarkdown);
			} else if (res.toolUsed === 'gogetdoc') {
				// declaration is of the form "func Add(a int, b int) int"
				declarationText = declarationText.substring(5);
				let funcNameStart = declarationText.indexOf(res.name + '('); // Find 'functionname(' to remove anything before it
				if (funcNameStart > 0) {
					declarationText = declarationText.substring(funcNameStart);
				}
				si = new SignatureInformation(declarationText, res.doc + "\n\ngogetdoc");
				sig = declarationText.substring(res.name.length);
			}

			si.parameters = getParametersAndReturnType(sig).params.map(paramText =>
				// console.log(paramText);
				new ParameterInformation(paramText + "\n\nparamText")
			)
			result.signatures = [si];
			result.activeSignature = 0;
			result.activeParameter = Math.min(nrOfCommas, si.parameters.length - 1);
			return result;
		});

		return <Promise<SignatureHelp>>responses;
	}
	public provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken): Promise<SignatureHelp> {
		if (!this.goConfig) {
			this.goConfig = vscode.workspace.getConfiguration('go', document.uri);
		}

		let theCall = this.walkBackwardsToBeginningOfCall(document, position);
		if (theCall == null) {
			return Promise.resolve(null);
		}
		let callerPos = this.previousTokenPosition(document, theCall.openParen);
		// Temporary fix to fall back to godoc if guru is the set docsTool
		let goConfig = this.goConfig;
		if (goConfig['docsTool'] === 'guru') {
			goConfig = Object.assign({}, goConfig, { 'docsTool': 'godoc' });
		}
		return definitionLocation(document, callerPos, goConfig, true, token).then(res => {
			return this.getPopularPatterns(callerPos, res, theCall.commas.length);
		}, () => {
			return null;
		});
	}

	private previousTokenPosition(document: TextDocument, position: Position): Position {
		while (position.character > 0) {
			let word = document.getWordRangeAtPosition(position);
			if (word) {
				return word.start;
			}
			position = position.translate(0, -1);
		}
		return null;
	}

	private walkBackwardsToBeginningOfCall(document: TextDocument, position: Position): { openParen: Position, commas: Position[] } {
		let parenBalance = 0;
		let commas = [];
		let maxLookupLines = 30;

		for (let line = position.line; line >= 0 && maxLookupLines >= 0; line--, maxLookupLines--) {
			let currentLine = document.lineAt(line).text;
			let characterPosition = document.lineAt(line).text.length - 1;

			if (line === position.line) {
				characterPosition = position.character;
				currentLine = currentLine.substring(0, position.character);
			}

			for (let char = characterPosition; char >= 0; char--) {
				switch (currentLine[char]) {
					case '(':
						parenBalance--;
						if (parenBalance < 0) {
							return {
								openParen: new Position(line, char),
								commas: commas
							};
						}
						break;
					case ')':
						parenBalance++;
						break;
					case ',':
						if (parenBalance === 0) {
							commas.push(new Position(line, char));
						}
				}
			}
		}
		return null;
	}

}
